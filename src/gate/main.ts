// A stable entry point (docs/packaging-plan.md step 2): the systemd units and the
// deploy scripts name this path, and they outlive a release (a rollback keeps the
// units), so it stays here and loads the file that moved.
export * from '@panel/pammy/gate/main';
