# OpenWetter — persistent Android release signing

OpenWetter preview APKs have been signed with **ephemeral GitHub-runner debug keys**. Android treats builds signed with a different certificate as different developers: a newly built preview may require uninstalling the previous one (and losing its locally stored preferences).

For seamless **updates** of private builds, generate your own persistent Android signing certificate and keep it safely outside the public source repository. Reuse **exactly the same keystore and alias** for every signed release.

**Signing is not a bypass for Google Play Protect scanning.** Google may still display its 'App scan recommended' warning when installing an APK downloaded from GitHub or another non-Play source; see [Google's warning guidance](https://developers.google.com/android/play-protect/warning-dev-guidance). For a less intrusive mainstream distribution path, publishing through Google Play is generally better, but it requires the Play Console and complying with its app review and policy process.

## One-time preparation on your own computer

Requires a JDK with `keytool`. On your own computer, from a private folder, run:

```sh
keytool -genkeypair -v -keystore openwetter-release.jks -storetype PKCS12 \
  -alias openwetter -keyalg RSA -keysize 4096 -validity 10000 \
  -dname 'CN=OpenWetter Personal Release, O=OpenWetter, C=DE'
```

Use strong passwords and retain them. This file is your **private signing key**. Never commit it, upload it into chat, or attach it to a public GitHub issue or release. Make a secure offline backup; losing it prevents future regular updates under that signing identity.

Encode it as one line. With GNU `base64`:

```sh
base64 -w 0 openwetter-release.jks
```

On macOS:

```sh
base64 -i openwetter-release.jks | tr -d '\n'
```

In GitHub, go to **OpenWetter > Settings > Secrets and variables > Actions > New repository secret** and set four secrets:

| Name | Value |
|---|---|
| `OPENWETTER_KEYSTORE_BASE64` | The one-line base64 representation of the keystore bytes |
| `OPENWETTER_KEYSTORE_PASSWORD` | Password entered when creating the keystore |
| `OPENWETTER_KEY_ALIAS` | `openwetter` |
| `OPENWETTER_KEY_PASSWORD` | Key password, often same as the keystore password with PKCS12 |

**Do not give the assistant these values.** GitHub Actions injects them privately at build time.

## Build a signed release

Visit [Actions > Build independently signed Android APK](https://github.com/e-kotov/OpenWetter/actions/workflows/signed-release.yml), choose **Run workflow**, and enter a **new tag** such as `v0.1.0-beta.1`. The workflow runs the official Android SDK `zipalign` and `apksigner`, checks the signature, then publishes a GitHub Release with a signed APK and SHA-256 checksum. The app version is stamped from the tag, and signed workflow runs use increasing version codes.

### First migration from debug APK

Because the existing debug APK was signed with a different key, uninstall the old preview before installing your first persistently signed build. After that, updates made with the **same** release key can normally be installed without uninstalling (provided the version code increases).

Future user-installed APKs may still receive Play Protect checks. A signature authenticates updates; it does not certify the APK as reviewed by Google.
