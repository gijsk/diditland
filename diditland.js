var nightly, bugnumber, form, result, statusEl;
var gRepoWeWant = "mozilla-central";
var gFoundBackout = false;

function getCommentURL(bug) {
  return "https://bugzilla.mozilla.org/rest/bug/" + bug + "/comment";
}

function getLogURLToCheckItemInAncestryOf(repo, cset, other) {
  repo = repo == "mozilla-central" ? repo : "releases/" + repo;
  return "https://hg.mozilla.org/" + repo + "/log?rev=" + encodeURIComponent("::" + other + " & " + cset);
}

function getTaskClusterURL(nightlyData) {
  return "https://index.taskcluster.net/v1/namespaces/gecko.v2." + gRepoWeWant + ".nightly." +
         Array.prototype.slice.apply(nightlyData, [1, 4]).join('.') +
         ".revision";
}

function getBetaJSONURL(betaTag) {
  return "https://hg.mozilla.org/releases/mozilla-beta/json-rev/" + encodeURIComponent(betaTag);
}

function appendStatusMsg(msg) {
  var p = document.createElement("p");
  p.textContent = msg;
  result.appendChild(p);
}

function requestURL(method, url, responseType, postData) {
  return new Promise(function(resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open(method.toUpperCase(), url);
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
    postJSON(getTaskClusterURL(nightlyData)).then(function(loadEvent) {
      var obj = loadEvent.target.response;
      if (loadEvent.target.status == 200) {
        var hashes = obj.namespaces.map(function(x) { return x.name });
        if (hashes.length > 1) {
          result.appendChild(document.createTextNode("Warning: more than one nightly built that day: " + hashes.join(', ')));
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
      var hglinkMultiMatch = /https?:\/\/hg\.mozilla\.org\/([\w-]+\/)+rev\/([a-f0-9]+)/gi;
      // The same, but without the 'global' flag so we get the groups:
      var hglinkSingleMatch = new RegExp(hglinkMultiMatch, "i");
      comments.forEach(function(comment) {
        var hglinks = comment.text.match(hglinkMultiMatch);
        if (hglinks) {
          for (var link of hglinks) {
            var linkInfo = link.match(hglinkSingleMatch);
            // This will be the trailing path component, so for
            // ...org/releases/mozilla-beta/
            // ...org/integration/fx-team/
            // ...org/mozilla-central/
            // it will always do the right thing:
            var repo = linkInfo[1].replace(/\/$/i, "");
            var hash = linkInfo[2];
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
      statusEl.textContent = "Maybe";
    } else {
      statusEl.textContent = "No";
    }
  });
}

function onSubmit(e) {
  e.preventDefault();
  e.stopPropagation();
  result.innerHTML = "";
  statusEl.textContent = "Checking...";

  gRepoWeWant = document.querySelector("input[name=repo]:checked").value;
  gFoundBackout = false;

  var bug = bugnumber.value.trim();
  var nightlyData = nightly.value.match(new RegExp(nightly.getAttribute("pattern")));
  var gotCommitInfo = getCommitInfo(bug);
  var gotBuildHash, buildHashMessage;
  if (gRepoWeWant == "mozilla-beta") {
    buildHashMessage = "beta tag: ";
    gotBuildHash = getBetaPromise();
  } else {
    buildHashMessage = "nightly that day has hash: ";
    gotBuildHash = getNightlyFromTaskCluster(nightlyData);
  }

  // Ensure we get some informational output:
  gotCommitInfo.then(function(repoToHashMap) {
    for (var [repo, hashes] of repoToHashMap) {
      appendStatusMsg(repo + ": hashes " + [... hashes].join(', ') + " landed.");
    }
  });
  var safeGotBuildHash = gotBuildHash.then(function(hash) {
    appendStatusMsg(buildHashMessage + hash);
    return hash;
  }, function(error) {
    appendStatusMsg("Failed to get build hash: " + error);
    statusEl.textContent = "Failed to get build hash for the nightly/aurora/beta build you indicated."
  });
  // And do the final trick:
  Promise.all([gotCommitInfo, safeGotBuildHash]).then(checkFixedInBuild, function(someError) {
    statusEl.textContent = "No idea - something broke.";
    console.error(someError);
  });
  return false;
}

function onLoad() {
  nightly = document.getElementById("nightly");
  bugnumber = document.getElementById("bugnumber");
  result = document.getElementById("result");
  statusEl = document.getElementById("status");

  form = document.getElementById("landed");
  form.addEventListener("submit", onSubmit, false);

  if (!nightly.value) {
    var today = new Date();
    nightly.value = today.getFullYear() + "-" + (today.getMonth() + 1) + "-" + today.getDate();
  }
}

document.addEventListener("DOMContentLoaded", onLoad, false);

