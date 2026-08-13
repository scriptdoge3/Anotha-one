#!/usr/bin/env bash
#
# Build the Load Bank APK.
#
# Deliberately does not use Gradle: the app is one Activity and a folder of
# static assets, so driving the SDK tools directly is faster, has no plugin
# resolution to go wrong, and needs nothing beyond build-tools and a platform
# jar.
#
#   aapt2 compile/link  ->  resources + manifest
#   javac               ->  .class
#   d8                  ->  classes.dex
#   zipalign            ->  aligned APK
#   apksigner           ->  signed APK
#
# Usage:  ANDROID_SDK_ROOT=/path/to/sdk scripts/build-apk.sh [--release]
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

: "${ANDROID_SDK_ROOT:?Set ANDROID_SDK_ROOT to your Android SDK}"
BUILD_TOOLS_VER="${BUILD_TOOLS_VER:-34.0.0}"
PLATFORM_VER="${PLATFORM_VER:-android-34}"

BT="$ANDROID_SDK_ROOT/build-tools/$BUILD_TOOLS_VER"
ANDROID_JAR="$ANDROID_SDK_ROOT/platforms/$PLATFORM_VER/android.jar"
[ -x "$BT/aapt2" ] || { echo "aapt2 not found at $BT" >&2; exit 1; }
[ -f "$ANDROID_JAR" ] || { echo "android.jar not found at $ANDROID_JAR" >&2; exit 1; }

OUT="$ROOT/build"
ASSETS="$OUT/assets"
rm -rf "$OUT"
mkdir -p "$OUT/res" "$OUT/gen" "$OUT/classes" "$ASSETS"

# ---- 1. stage the web app as assets ---------------------------------------
# Only what the game actually loads; no tests, scripts or tooling.
echo "==> staging assets"
cp index.html styles.css fonts.css "$ASSETS/"
mkdir -p "$ASSETS/src"
cp src/*.js "$ASSETS/src/"

# ---- 2. resources ---------------------------------------------------------
echo "==> compiling resources"
"$BT/aapt2" compile --dir android/res -o "$OUT/res.zip"

echo "==> linking"
"$BT/aapt2" link \
  -o "$OUT/base.apk" \
  -I "$ANDROID_JAR" \
  --manifest android/AndroidManifest.xml \
  -A "$ASSETS" \
  --java "$OUT/gen" \
  --auto-add-overlay \
  "$OUT/res.zip"

# ---- 3. java --------------------------------------------------------------
echo "==> compiling java"
find android/java "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
# core-lambda-stubs supplies LambdaMetafactory, which android.jar does not
# carry; without it any lambda in the source fails to compile.
if ! javac -source 8 -target 8 -nowarn \
  -bootclasspath "$ANDROID_JAR" \
  -classpath "$ANDROID_JAR:$BT/core-lambda-stubs.jar" \
  -d "$OUT/classes" \
  @"$OUT/sources.txt" > "$OUT/javac.log" 2>&1
then
  grep -v 'JAVA_TOOL_OPTIONS' "$OUT/javac.log" >&2
  echo "java compilation failed" >&2
  exit 1
fi

echo "==> dexing"
"$BT/d8" --min-api 24 --output "$OUT" \
  $(find "$OUT/classes" -name '*.class') > "$OUT/d8.log" 2>&1
[ -f "$OUT/classes.dex" ] || { grep -v 'JAVA_TOOL_OPTIONS' "$OUT/d8.log" >&2; echo "dexing failed" >&2; exit 1; }

# ---- 4. package -----------------------------------------------------------
echo "==> packaging"
cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT" && zip -q unsigned.apk classes.dex)

# ---- 5. sign --------------------------------------------------------------
# A local keystore is generated on first run. This signs a *debug-grade* build:
# fine for sideloading, not a Play Store upload key.
KEYSTORE="${KEYSTORE:-$ROOT/android/loadbank.keystore}"
KS_PASS="${KS_PASS:-loadbank}"
if [ ! -f "$KEYSTORE" ]; then
  echo "==> generating signing key"
  keytool -genkeypair -v \
    -keystore "$KEYSTORE" -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -alias loadbank -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Load Bank, OU=Yard, O=Load Bank, L=, S=, C=GB" >/dev/null 2>&1
fi

echo "==> aligning and signing"
"$BT/zipalign" -p -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
"$BT/apksigner" sign \
  --ks "$KEYSTORE" --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --v1-signing-enabled true --v2-signing-enabled true \
  --out "$ROOT/load-bank.apk" "$OUT/aligned.apk"

"$BT/apksigner" verify --print-certs "$ROOT/load-bank.apk" | head -3

SIZE=$(du -h "$ROOT/load-bank.apk" | cut -f1)
echo
echo "built load-bank.apk ($SIZE)"
