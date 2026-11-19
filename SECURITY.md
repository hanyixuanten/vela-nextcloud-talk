# Security policy

## Reporting a vulnerability

Please do not report exploitable security issues in public issues. Contact the repository maintainer privately through GitHub's security advisory reporting feature, or email the maintainer listed in the repository profile. Include affected versions, impact, and a reproducible description. Do not include live credentials or private user data.

## Scope and limitations

The app requires HTTPS for Nextcloud Basic-auth requests. App passwords are stored in the Vela app sandbox because the platform does not expose a keystore API; revoke the corresponding Nextcloud app password when clearing or losing a device. AstroBox interconnect is treated as a same-device trust boundary and the app does not implement certificate pinning.
