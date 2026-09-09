#!/usr/bin/env bash
# Rebuild the driver APK against THIS machine's current LAN address.
#
#     scripts/build_apk.sh              # detect the LAN IP and build
#     scripts/build_apk.sh 192.168.1.7  # or force one (venue wifi, hotspot)
#
# WHY THIS EXISTS
# ---------------
# The handset reaches the backend over wifi, so the app has to be built with an
# address the PHONE can resolve -- never "localhost", which on the handset is
# the handset. App.jsx reads that address from mobile-app/.env at COMPILE time
# through react-native-dotenv, so a new network means a new build. This script
# is that build, with the address detected rather than remembered: the previous
# APK shipped pointing at 172.60.2.75 because that was the laptop's address on
# the day it was built, and nothing noticed when the address changed.
#
# It rewrites only the API_URL line of .env and leaves every other key alone.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/.claude/worktrees/nav-experience/mobile-app"
ENV_FILE="$APP/.env"
NSC_FILE="$APP/android/app/src/main/res/xml/network_security_config.xml"

[[ -d "$APP" ]] || { echo "error: driver client not found at $APP" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "error: $ENV_FILE missing" >&2; exit 1; }
[[ -f "$NSC_FILE" ]] || { echo "error: $NSC_FILE missing" >&2; exit 1; }

if [[ -n "${1:-}" ]]; then
  IP="$1"
else
  # en0 is the wifi interface on this machine. Fall back to the first non-loopback
  # address if it is down (a wired dock, a phone hotspot on a different interface).
  IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
  [[ -z "$IP" ]] && IP="$(ifconfig | awk '/inet /&&$2!="127.0.0.1"{print $2; exit}')"
fi
[[ -n "$IP" ]] || { echo "error: could not determine a LAN address; pass one explicitly" >&2; exit 1; }

echo "==> building the driver client against http://$IP:4000"

# Rewrite API_URL in place, preserving every other key and all the comments.
python3 - "$ENV_FILE" "$IP" <<'PY'
import sys, pathlib
path, ip = pathlib.Path(sys.argv[1]), sys.argv[2]
lines = path.read_text().splitlines(keepends=True)
out, seen = [], False
for line in lines:
    if line.startswith('API_URL='):
        out.append(f'API_URL=http://{ip}:4000\n'); seen = True
    else:
        out.append(line)
if not seen:
    out.append(f'\nAPI_URL=http://{ip}:4000\n')
path.write_text(''.join(out))
print(f'    .env API_URL -> http://{ip}:4000')
PY

# The SECOND place the address lives, and the reason this script exists in the
# form it does.
#
# targetSdk is 34, so Android denies cleartext by default and the release build
# consults network_security_config.xml for exceptions. Updating .env alone
# produces an APK that asks for the right address and is then refused
# permission to reach it -- and the failure is silent and deeply misleading:
# the phone's BROWSER loads /health without trouble (Chrome does not read this
# file), so every symptom says "React Native is broken" and none say "the
# allowlist still names last week's IP". Observed exactly once, on the build
# this line was added to prevent.
python3 - "$NSC_FILE" "$IP" <<'PYN'
import re, sys, pathlib
path, ip = pathlib.Path(sys.argv[1]), sys.argv[2]
text = path.read_text()
# Rewrite only the literal IPv4 bring-up host; localhost and the emulator alias
# 10.0.2.2 are stable and must survive.
def sub(m):
    host = m.group(1)
    if host in ('localhost', '10.0.2.2'):
        return m.group(0)
    return m.group(0).replace(host, ip)
new = re.sub(r'<domain includeSubdomains="false">([^<]+)</domain>', sub, text)
if new != text:
    path.write_text(new)
print(f'    cleartext allowlist -> {ip}')
PYN

# Validate it before gradle does. aapt2's failure for a malformed comment is
# "Resource compilation failed ... ParseError at [19,36]" four minutes into the
# build, with no hint that the file was hand-edited; this fails in a second.
python3 -c "import sys,xml.dom.minidom; xml.dom.minidom.parse('$NSC_FILE')" \
  || { echo "error: $NSC_FILE is not valid XML" >&2; exit 1; }

# react-native-dotenv inlines .env at TRANSFORM time and Metro caches the
# transformed module, so a rebuild without this happily ships the PREVIOUS
# address and looks like the edit did not take.
echo "==> clearing Metro cache"
rm -rf "${TMPDIR:-/tmp}"/metro-* "${TMPDIR:-/tmp}"/haste-map-* 2>/dev/null || true

# RELEASE, not debug, and this is the difference between a demo and a dead app.
# A React Native DEBUG apk contains no index.android.bundle at all -- it pulls
# the JavaScript from a Metro dev server over the network every launch. On a
# venue wifi with no Metro reachable it opens to a red screen. `assembleRelease`
# embeds the bundle, so the handset needs nothing from this laptop except the
# backend itself. It is signed with the debug keystore (app/build.gradle:141),
# so there is no key to provision.
#
# This is also why the .env edit above only takes effect on a release build:
# gradle does not treat JavaScript as an input to assembleDebug, which reports
# BUILD SUCCESSFUL in five seconds having changed nothing.
# --rerun on createBundleReleaseJsAndAssets is what makes the .env edit above
# actually reach the handset, and without it this script ships last network's
# address while reporting BUILD SUCCESSFUL.
#
# The bundle task declares its inputs as a file tree of **/*.{js,jsx,ts,tsx}
# (BundleHermesCTask.kt:32-41). `.env` matches none of those extensions, so it
# is not an input at all: rewriting API_URL leaves gradle's up-to-date check
# perfectly satisfied, Metro never runs, and the PREVIOUS index.android.bundle
# -- carrying the previous IP -- is repackaged into the new APK. Clearing the
# Metro cache does not help, because Metro is never invoked to consult it.
#
# The tell is `> Task :app:createBundleReleaseJsAndAssets UP-TO-DATE` and a
# 17-second build. Observed on the build this flag was added to prevent: the
# cleartext allowlist updated correctly (an .xml IS a real resource input)
# while the bundle still asked for 172.60.0.161, which is the two-address
# failure reassembled inside a single APK.
#
# `--rerun` applies ONLY to the tasks named on the command line, so this stays
# an incremental build (~25 s); `--rerun-tasks` would rebuild all 476 tasks.
echo "==> gradle assembleRelease (a few minutes; it bundles and minifies)"
( cd "$APP/android" && ./gradlew createBundleReleaseJsAndAssets --rerun assembleRelease )

APK="$APP/android/app/build/outputs/apk/release/app-release.apk"
[[ -f "$APK" ]] || { echo "error: build reported success but no APK at $APK" >&2; exit 1; }

# Prove the address actually made it in, rather than trusting "BUILD SUCCESSFUL".
#
# Searched as RAW BYTES, not with grep or strings. The bundle is Hermes
# bytecode, which packs its string table without null terminators -- `strings`
# finds nothing and grep reports only "Binary file matches", so both of the
# obvious checks here give a false negative on a build that is perfectly fine.
echo "==> verifying the address embedded in the bundle"
python3 - "$APK" "$IP" <<'PYV'
import sys, zipfile
apk, ip = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(apk)

# 1. the JavaScript. Hermes bytecode packs its string table without null
#    terminators, so grep says only "Binary file matches" and `strings` finds
#    nothing at all -- both give a false negative on a perfectly good build.
#    Counted as raw bytes instead.
bundle = z.read('assets/index.android.bundle')
url = f'http://{ip}:4000'.encode()
ok_bundle = bundle.count(url)

# 2. the cleartext allowlist. Resource file names are obfuscated in a release
#    build (res/8G.xml and the like), so every res/ entry is searched rather
#    than one known path.
ok_nsc, where = 0, None
for name in z.namelist():
    if name.startswith('res/') and name.endswith('.xml'):
        d = z.read(name)
        if d.count(ip.encode()):
            ok_nsc, where = 1, name
            break

# 3. and no stale address may survive anywhere.
stale = set()
for name in z.namelist():
    if name.startswith('res/') or name == 'assets/index.android.bundle':
        d = z.read(name)
        for tok in set(__import__('re').findall(rb'(?:\d{1,3}\.){3}\d{1,3}', d)):
            t = tok.decode()
            if t.startswith(('172.', '192.168.', '10.')) and t != ip and t != '10.0.2.2':
                stale.add(f'{t} in {name}')

print(f'    {"ok  " if ok_bundle else "FAIL"} bundle url http://{ip}:4000 ({ok_bundle}x)')
print(f'    {"ok  " if ok_nsc else "FAIL"} cleartext allowlist has {ip}'
      + (f' ({where})' if where else ''))
for sline in sorted(stale):
    print(f'    WARN stale address {sline}')
sys.exit(0 if (ok_bundle and ok_nsc) else 1)
PYV

echo
echo "==> APK: $APK"
echo "    $(du -h "$APK" | cut -f1), built $(date -r "$APK" '+%Y-%m-%d %H:%M')"
echo
echo "Install over USB:      adb install -r \"$APK\""
echo "Or copy it to the phone and open it from the file manager."
echo
echo "The phone and this laptop must be on the SAME wifi network."
echo "Verify from the phone's browser first:  http://$IP:4000/health"
