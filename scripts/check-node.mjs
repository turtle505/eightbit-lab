// Runs before the backend starts. The app imports the built-in node:sqlite, which older Node versions
// only have behind a flag, so without this check they fail with a confusing import error.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(
    `8-bit Lab needs Node 22.13 or newer (this is v${process.versions.node}). Install Node 24 LTS from https://nodejs.org, or run \`nvm use\`.\n` +
      `8-bit Lab은 Node 22.13 이상이 필요합니다 (지금 v${process.versions.node}). https://nodejs.org 에서 Node 24 LTS를 설치하거나 \`nvm use\`를 실행하세요.`,
  );
  process.exit(1);
}
