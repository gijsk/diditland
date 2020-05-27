var nightly, bugnumber, form, result, statusEl;
var gRepoWeWant = "mozilla-central";
var gFoundBackout = false;

var gCanonicalRepoURLs = new Map([
  ["fx-team", "https://hg.mozilla.org/integration/fx-team/rev/"],
  ["mozilla-inbound", "https://hg.mozilla.org/integration/mozilla-inbound/rev/"],
  ["autoland", "https://hg.mozilla.org/integration/autoland/rev/"],
  ["mozilla-central", "https://hg.mozilla.org/mozilla-central/rev/"],
  ["mozilla-beta", "https://hg.mozilla.org/releases/mozilla-beta/rev/"],
  ["mozilla-release", "https://hg.mozilla.org/releases/mozilla-release/rev/"],
]);

var gBuildHubURL = "https://buildhub.moz.tools/api/search";


var gMercurialLinkMultiMatch = /https?:\/\/hg\.mozilla\.org\/([\w-]+\/)+rev\/([a-f0-9]+)/gi;
// The same, but without the 'global' flag so we get the groups:
var gMercurialLinkSingleMatch = new RegExp(gMercurialLinkMultiMatch, "i");

function getCommentURL(bug) {
  return "https://bugzilla.mozilla.org/rest/bug/" + bug + "/comment";
}

function getLogURLToCheckItemInAncestryOf(repo, cset, other) {
  repo = repo == "mozilla-central" ? repo : "releases/" + repo;
  return "https://hg.mozilla.org/" + repo + "/log?rev=" + encodeURIComponent("::" + other + " & " + cset);
}

function getBuildHubQuery(nightlyData) {
  let date = Array.prototype.slice.apply(nightlyData, [1, 4]).join('');
  return JSON.stringify({
    query: {
      query_string: {
        default_operator: "AND",
        query: "source.product:firefox target.channel:nightly build.id:" + date + "*",
      }
    },
    size: 30,
    sort: [{ "download.date": "desc" }],
  });
}

function findLatestBeta() {
  return fetch(
    "https://product-details.mozilla.org/1.0/firefox_versions.json"
  ).then(
    function(resp) { return resp.json() }
  ).then(
    function(json) {
      let beta = json.LATEST_FIREFOX_RELEASED_DEVEL_VERSION;
      beta = beta.split("b");
      document.getElementById("beta-version").value = parseInt(beta[0], 10);
      document.getElementById("beta-build").value = beta[1];
    }
  );
}

function getBetaJSONURL(betaTag) {
  return "https://hg.mozilla.org/releases/mozilla-beta/json-rev/" + encodeURIComponent(betaTag);
}

function parseRepoAndHashFromURL(url) {
  var linkInfo = url.match(gMercurialLinkSingleMatch);
  if (linkInfo) {
    // This will be the trailing path component, so for
    // ...org/releases/mozilla-beta/
    // ...org/integration/fx-team/
    // ...org/mozilla-central/
    // it will always do the right thing:
    return [linkInfo[1].replace(/\/$/i, ""), linkInfo[2]];
  }
  return null;
}

function appendStatusMsg(msg) {
  var p = document.createElement("p");
  if (typeof msg == "string") {
    p.textContent = msg;
  } else {
    p.appendChild(msg);
  }
  result.appendChild(p);
}

function requestURL(method, url, responseType, postData) {
  return new Promise(function(resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open(method.toUpperCase(), url);
    if (method.toUpperCase() == 'POST') {
      xhr.setRequestHeader("Content-Type", "application/json");
    }
    if (responseType == "json") {
      xhr.setRequestHeader("Accept", "application/json");
    } else if (responseType == "html") {
      xhr.setRequestHeader("Accept", "text/html");
    }
    xhr.responseType = responseType;
    xhr.onload = resolve;
    xhr.onerror = reject;
    if (postData) {
      xhr.send(postData);
    } else {
      xhr.send();
    }
  });
}

function getJSON(url) {
  return requestURL("GET", url, "json");
}

function getHTML(url) {
  return requestURL("GET", url, "document");
}

function postJSON(url, postData) {
  return requestURL("POST", url, "json", postData);
}

function getNightlyFromTaskCluster(nightlyData) {
  return new Promise(function(resolve, reject) {
    postJSON(gBuildHubURL, getBuildHubQuery(nightlyData)).then(function(loadEvent) {
      var obj = loadEvent.target.response;
      if (loadEvent.target.status == 200) {
        var hashes = obj.hits.hits.map(function(hit) { return hit._source.source.revision });
        hashes = Array.from(new Set(hashes));
        if (hashes.length > 1) {
          result.appendChild(document.createTextNode("Warning: more than one nightly built that day: "));
          for (let i = 0; i < hashes.length; i++) {
            let hash = hashes[i];
            let link = document.createElement("a");
            link.href = gCanonicalRepoURLs.get(gRepoWeWant) + hash;
            link.textContent = hash;
            result.appendChild(link);
            if (i < hashes.length - 1) {
              result.append(", ");
            }
          }
        } else if (hashes.length == 0) {
          reject("No nightly built that day.");
          return;
        }
        resolve(hashes.pop());
      } else {
        reject("Didn't load correctly, got " + loadEvent.target.status + " response: " + JSON.stringify(obj));
      }
    }, function(err) {
      console.error(err);
      reject(err);
    });
  })
}

function getBetaPromise() {
  var version = document.getElementById("beta-version").value;
  var build = document.getElementById("beta-build").value;
  var tag = "FIREFOX_" + version + "_0b" + build + "_RELEASE";
  return new Promise(function(resolve, reject) {
    getJSON(getBetaJSONURL(tag)).then(function(loadEvent) {
      var response = loadEvent.target.response;
      if (response.tags) {
        resolve(tag);
      } else {
        reject("No such beta build exists.");
      }
    }, function(err) {
      appendStatusMsg(err);
      console.error(err);
      reject(err);
    });
  });
}

function getCommitInfo(bug) {
  return new Promise(function(resolve, reject) {
    getJSON(getCommentURL(bug)).then(function(loadEvent) {
      var response = loadEvent.target.response;
      if (response.error) {
        appendStatusMsg("Got error from bugzilla, see console.");
        console.error(response);
        reject(response);
        return;
      }
      var comments = response.bugs[bug].comments;
      var repoToHashMap = new Map();
      comments.forEach(function(comment) {
        var hglinks = comment.text.match(gMercurialLinkMultiMatch);
        if (hglinks) {
          for (var link of hglinks) {
            var [repo, hash] = parseRepoAndHashFromURL(link);
            if (!repoToHashMap.has(repo)) {
              repoToHashMap.set(repo, new Set());
            }
            var repoInfo = repoToHashMap.get(repo);
            repoInfo.add(hash);

            if (repo == gRepoWeWant && !gFoundBackout &&
                comment.text.toLowerCase().indexOf("backout") != -1 ||
                comment.text.toLowerCase().indexOf("backed out") != -1) {
              gFoundBackout = true;
              appendStatusMsg("Warning: it looks like one or more changesets were backed out.");
            }
          }
        }
      });
      resolve(repoToHashMap);
    }, function(error) {
      console.error(error);
      appendStatusMsg("Failed to get comments for bug " + bug + ".");
      reject(error);
    });
  })
}

function checkFixedInBuild([repoToHashMap, buildHash]) {
  if (!buildHash) {
    return;
  }
  var relevantChangesets = repoToHashMap.get(gRepoWeWant);
  var checks = [];
  if (relevantChangesets) {
    for (var cset of relevantChangesets) {
      checks.push(new Promise(function(resolve, reject) {
        var desiredURL = getLogURLToCheckItemInAncestryOf(gRepoWeWant, cset, buildHash);
        getHTML(desiredURL).then(function(loadEvent) {
          try {
            resolve(!!loadEvent.target.response.querySelector(".log_link"));
          } catch (ex) {
            reject(ex);
          }
        });
      }));
    }
  } else {
    checks.push(Promise.resolve(false));
  }
  return Promise.all(checks).then(function(checkResults) {
    if (!gFoundBackout && checkResults.every(function(x) { return x })) {
      statusEl.textContent = "Yes";
    } else if (checkResults.some(function(x) { return x })) {
      statusEl.textContent = "Maybe - only some of the changes landed in this nightly";
    } else {
      statusEl.textContent = "No";
    }
  });
}

function onSubmit(e) {
  e.preventDefault();
  e.stopPropagation();
  result.innerHTML = "";
  statusEl.textContent = "";

  gRepoWeWant = document.querySelector("input[name=repo]:checked").value;
  gFoundBackout = false;

  var source = document.querySelector("input[name=commit-source]:checked").value;
  var gotCommitInfo;
  if (source == "bug") {
    var bug = bugnumber.value.trim();
    gotCommitInfo = getCommitInfo(bug);
  } else {
    var hash = revision.value;
    var commitInfo = new Map([[gRepoWeWant, new Set([hash])]]);
    gotCommitInfo = Promise.resolve(commitInfo);
  }

  var gotBuildHash, buildHashMessage;
  if (gRepoWeWant == "mozilla-beta") {
    buildHashMessage = "beta tag: ";
    gotBuildHash = getBetaPromise();
  } else {
    var nightlyData = nightly.value.match(new RegExp(nightly.getAttribute("pattern")));
    if (!nightlyData) {
      appendStatusMsg("Invalid nightly date specified (use yyyy-mm-dd).");
      return;
    }
    buildHashMessage = "nightly that day has hash: ";
    gotBuildHash = getNightlyFromTaskCluster(nightlyData);
  }

  statusEl.textContent = "Checking...";

  // Ensure we get some informational output:
  gotCommitInfo.then(function(repoToHashMap) {
    for (var [repo, hashes] of repoToHashMap) {
      let content = new DocumentFragment();
      content.append(repo);
      content.append(": hashes ");
      hashes = Array.from(hashes);
      for (var i = 0; i < hashes.length; i++) {
        let hash = hashes[i];
        let link = document.createElement("a");
        link.href = gCanonicalRepoURLs.get(repo) + hash;
        link.textContent = hash;
        content.append(link);
        if (i < hashes.length - 1) {
          content.append(", ");
        }
      }
      content.append(" landed.");
      appendStatusMsg(content);
    }
  });
  var safeGotBuildHash = gotBuildHash.then(function(hash) {
    let docFrag = new DocumentFragment();
    docFrag.append(buildHashMessage);
    let link = document.createElement("a");
    link.href = gCanonicalRepoURLs.get(gRepoWeWant) + hash;
    link.textContent = hash;
    docFrag.append(link);
    appendStatusMsg(docFrag);
    return hash;
  }, function(error) {
    appendStatusMsg("Failed to get build hash: " + error);
    statusEl.textContent = "Failed to get build hash for the nightly/beta build you indicated."
  });
  // And do the final trick:
  Promise.all([gotCommitInfo, safeGotBuildHash]).then(checkFixedInBuild, function(someError) {
    console.error(someError);
    if (someError && someError.message) {
      statusEl.textContent = someError.message;
      return;
    }
  });
  return false;
}

function onLoad() {
  findLatestBeta();
  nightly = document.getElementById("nightly");
  bugnumber = document.getElementById("bugnumber");
  result = document.getElementById("result");
  statusEl = document.getElementById("status");
  revision = document.getElementById("revision");

  form = document.getElementById("landed");
  form.addEventListener("submit", onSubmit, false);

  if (!nightly.value) {
    var today = new Date();
    var month = ("0" + (today.getMonth() + 1)).substr(-2);
    var day = ("0" + today.getDate()).substr(-2);
    nightly.value = today.getFullYear() + "-" + month + "-" + day;
  }
}

document.addEventListener("DOMContentLoaded", onLoad, false);

