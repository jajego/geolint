# Security policy

Report suspected vulnerabilities privately through GitHub's security-advisory feature for `jajego/geolint`. Do not open a public issue containing an undisclosed exploit. Supported releases receive security fixes according to their current npm support status.

GeoLint is a local development and CI tool, not a sandbox. Executable config modules and plugins are JavaScript code and run with the privileges of the Node.js process; load only trusted code. GeoJSON input is treated as data, but adversarially large inputs can consume CPU and memory. Diagnostic retention is bounded, while parsing and semantic analysis still scale with input size.

Use ordinary CI least privilege: restrict secrets, review configuration/plugin changes, and apply operating-system resource controls when analyzing untrusted artifacts.
