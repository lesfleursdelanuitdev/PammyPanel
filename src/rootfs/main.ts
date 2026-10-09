// A stable entry point (docs/packaging-plan.md step 2): pammy-rootfs@.service names
// this path, and it outlives a release, so it stays here and loads the file that moved.
export * from '@panel/pammy/helpers/rootfs';
