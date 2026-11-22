# Security

If you find a way that someone or something could read or change a person's documents, settings or files through Corillo without their say, please report it privately, not in a public issue.

Report it through GitHub's private vulnerability reporting, on [Corillo's repository](https://github.com/oneillo/corillo). There's no email address for this.

1. Go to https://github.com/oneillo/corillo.
2. Under the repository's name, click the Security and quality tab. If you don't see it, click the ··· menu and choose Security and quality there.
3. Click Report a vulnerability.
4. Fill in the form, then click Submit report at the bottom.

These steps are from GitHub's page [Privately reporting a security vulnerability](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability). If there's no Report a vulnerability button, open an issue that only asks for a private way to report a problem, and leave out what the problem is.

Please include:

- what you found, and the steps that show it;
- Corillo's version and build (Corillo > About Corillo) and your macOS version.

Please give time for a fix before you share it publicly. Fixes go into the latest release.

## What's in scope

- The connector agents use: the local socket Corillo listens on, and what an agent can do through it.
- The window opening or writing a file the person didn't give it.
- The changes Connect makes to agent tools' settings files.
- Anything that sends a person's data off their Mac, or opens a network port.
