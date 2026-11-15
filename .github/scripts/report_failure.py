import os, json, urllib.request
path = os.path.join(os.environ.get("GITHUB_WORKSPACE", "."), "android", "build.log")
try:
    log = open(path).read()
if len(log) > 60000:
    log = log[:30000] + '\n...TRUNCATED...\n' + log[-30000:]
except Exception as e:
    log = "could not read build.log: " + str(e)
payload = json.dumps({"title": "Android build failure", "body": "```\n" + log + "\n```"}).encode()
req = urllib.request.Request(
    "https://api.github.com/repos/" + os.environ["GITHUB_REPOSITORY"] + "/issues",
    data=payload,
    headers={
        "Authorization": "Bearer " + os.environ["GITHUB_TOKEN"],
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
    },
)
try:
    urllib.request.urlopen(req)
except Exception as e:
    print("issue create failed:", e)
