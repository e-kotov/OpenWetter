# OpenWetter: permanent Android signing through GitHub Actions

**No Android Studio, Java installation, local key generation or terminal is required.**
GitHub Actions will generate OpenWetter's permanent RSA signing key, encrypt it using a secret known only to you and the Actions runner, and commit **only the encrypted keystore and public certificate** to the repository.

## One-time setup

1. In your password manager, generate a **random password of at least 40 characters** (48–64 characters is preferable). Save it there securely. This will protect both the release keystore and the encrypted file. Do not reuse your T3 Code signing key or any existing password.
2. Open [OpenWetter repository Actions secrets](https://github.com/e-kotov/OpenWetter/settings/secrets/actions). Click **New repository secret**. Name it exactly:
   
   `OPENWETTER_SIGNING_PASSPHRASE`
   
   Paste your newly generated password as the value and save it. Do not put it in a workflow input, issue, commit, chat or release.
3. Open [Provision OpenWetter signing key](https://github.com/e-kotov/OpenWetter/actions/workflows/provision-signing.yml). Click **Run workflow**, select **main**, and run it **once**.
4. Confirm the run succeeds and that it has committed [signing/openwetter-release.p12.gpg](signing/openwetter-release.p12.gpg) (encrypted private keystore) and [signing/openwetter-release.pem](signing/openwetter-release.pem) (public certificate) to the repository. The workflow will refuse to overwrite an existing identity.

Only the GPG-encrypted keystore and public certificate are committed. The unencrypted private keystore exists **only temporarily on the GitHub-hosted runner**, which is destroyed afterward. The password remains in GitHub Actions secrets and your password manager. GitHub Actions never uploads the plaintext key as an artifact.

**Important:** Because this repository is public, the encrypted keystore file is publicly accessible. Security relies on the password being genuinely random and long, and on protecting the GitHub Actions workflow and signing secret. Anyone with repository write access could change workflow code to misuse the secret; restrict write access and review changes carefully. For maximum key custody, generating a key on your own machine or using a hardware-backed service is safer.

## Back up the identity

Download an offline backup of the **encrypted** file `signing/openwetter-release.p12.gpg` and keep your password in a separate secure place. You need **both** the encrypted keystore and your original password to recover the signing key. Losing the password or the encrypted keystore prevents regular signed updates and may force a new application signing identity.

Never delete and regenerate the signing identity simply to produce a new APK. Permanent Android updates require the same private key and a higher version code.

## Publish permanently signed APKs

Once provisioned, open [Build independently signed Android APK](https://github.com/e-kotov/OpenWetter/actions/workflows/signed-release.yml), click **Run workflow** on **main**, choose a new version such as `v0.1.0-beta.1`, and keep **prerelease** enabled while testing.

That workflow builds the unsigned Android release APK, decrypts your provisioned key only on the Actions runner, signs with Android `apksigner`, verifies the APK signature against the public certificate, and attaches the signed APK and SHA-256 checksum to a GitHub Release.

The [signing-pipeline smoke test](https://github.com/e-kotov/OpenWetter/actions/workflows/signing-smoke.yml) uses a **throwaway key** to verify the complete process. It does not generate or expose the permanent release key.

## First installation and Play Protect

The previous OpenWetter alpha.1–alpha.5 APKs are signed with **different temporary CI debug keys**. You will need to uninstall your old debug preview **once** before installing your first permanently signed release, because Android cannot update across different signing identities. Back up any app settings you need before uninstalling.

After this, future releases signed with the same key and a higher Android version code should install over the existing app without clearing its data.

**Permanent signing does not bypass Google Play Protect scans.** Android may still recommend scanning sideloaded APKs downloaded from GitHub. If avoiding sideload scanning prompts is essential, Google Play's internal testing track is the more reliable distribution channel, but requires a Play Console account and publishing setup.

## Technical details

- Signing identity: PKCS#12, RSA 4096, alias `openwetter`.
- Key lifetime: 10,000 days.
- Private-key backup: GnuPG symmetric AES-256, salted iterated S2K with SHA-512.
- Credential: a single repository Actions secret, `OPENWETTER_SIGNING_PASSPHRASE`.
- Public certificate is committed for an independent signature identity check.
- GitHub Actions secret values cannot be viewed afterward; your password manager backup is essential.
