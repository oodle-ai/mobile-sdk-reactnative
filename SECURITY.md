# Security

## Report a vulnerability

Do not open a public issue for a security problem. Report it privately
through GitHub: open the **Security** tab of this repository and select
**Report a vulnerability**. We reply to each report and tell you when a
fix is released.

Include the SDK version, the platform (Android or iOS), the React Native
version, and the steps that show the problem.

## Supported versions

Security fixes go into the latest release. Update to it to get them.

## Data the SDK sends

The SDK sends RUM data only to the `endpoint` in its configuration, over
HTTPS. It accepts plain HTTP only for local and private network hosts.
The RUM API key in the app can only write RUM data. Session replay masks
all input fields by default, and request URLs are sent without their
query strings.
