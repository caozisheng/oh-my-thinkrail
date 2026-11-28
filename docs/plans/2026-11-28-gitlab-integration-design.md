# GitLab Integration Design

Issue #134 adds GitLab beside the existing GitHub and Matrix integrations. “Isomorphic to GitHub” means GitLab gets the same local CLI auth-status experience: an initial status probe, connected/login presentation, failure and loading states, and a manual Refresh action. The implementation will probe `glab auth status` on the host and expose typed `gitlab.authStatus` and `gitlab.refresh` requests. Its Settings group will appear on the existing Integrations page after GitHub and before Matrix.

The feature follows the existing GitHub server boundary and reuses its bounded subprocess runner. It will not add GitLab API access, credential storage, or a new protocol floor. GitLab translations will be added using the locale conventions already present in the repository. Tests will cover CLI output parsing and the UI states/navigation order.
