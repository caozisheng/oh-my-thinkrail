# Linked repository display fixes

Approved behavior: Project panel shows issue tags only for workspaces participating in an associated-repository group. The primary displays `#23(master)` and associated workspaces display `#23`. Single-repository issue workspaces have no tag.

IssuesTool reads saved repository selections after initial issue loading and every explicit refresh, using the existing `issues.repositories` RPC. Independent reads must not block the issue list or turn failures into confirmed empty selections. Existing popover reads remain available for retry and fresh lock state. Replies from superseded refreshes, project changes, or disconnected hosts must not overwrite current state.

The alternative of adding selection metadata to the list protocol expands the contract unnecessarily for these fixes. No new protocol or dependencies are needed. Focused unit and browser regressions cover tag visibility and linked buttons before any click, including refresh and stale replies; the complete no-agent browser gate validates integration.
