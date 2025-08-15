#!/usr/bin/env node

import { execSync } from 'child_process';
import { createInterface } from 'readline';

const rl = createInterface({
  input: process.stdin,
  output: process.stdout
});

function checkUncommittedChanges() {
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf8' });
    if (status.trim()) {
      console.error('❌ There are uncommitted changes. Please commit or stash them first:');
      console.error(status);
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error checking git status:', error.message);
    process.exit(1);
  }
}

function incrementVersion(version, type) {
  const [major, minor, patch] = version.split('.').map(Number);

  switch (type) {
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'major':
      return `${major + 1}.0.0`;
    default:
      throw new Error(`Unknown version type: ${type}`);
  }
}

function promptVersionType() {
  return new Promise((resolve) => {
    // Get current version using npm
    const versionOutput = execSync('npm version --json', { encoding: 'utf8' });
    const versions = JSON.parse(versionOutput);
    const currentVersion = versions[Object.keys(versions)[0]]; // Get the package version

    const patchVersion = incrementVersion(currentVersion, 'patch');
    const minorVersion = incrementVersion(currentVersion, 'minor');
    const majorVersion = incrementVersion(currentVersion, 'major');

    console.log(`\nCurrent version: ${currentVersion}`);
    console.log('\nSelect version increment type:');
    console.log(`1. patch (${currentVersion} → ${patchVersion}) - Bug fixes`);
    console.log(`2. minor (${currentVersion} → ${minorVersion}) - New features`);
    console.log(`3. major (${currentVersion} → ${majorVersion}) - Breaking changes`);

    rl.question('\nEnter your choice (1/2/3): ', (answer) => {
      const choice = answer.trim();
      switch (choice) {
        case '1':
          resolve('patch');
          break;
        case '2':
          resolve('minor');
          break;
        case '3':
          resolve('major');
          break;
        default:
          console.log('❌ Invalid choice. Please enter 1, 2, or 3.');
          resolve(promptVersionType());
      }
    });
  });
}

async function main() {
  console.log('Checking for uncommitted changes...');
  checkUncommittedChanges();

  console.log('No uncommitted changes found.');

  // Check if version type is provided as command line argument
  const args = process.argv.slice(2);
  let versionType;
  
  if (args.length > 0) {
    const providedType = args[0].toLowerCase();
    if (['patch', 'minor', 'major'].includes(providedType)) {
      versionType = providedType;
      console.log(`Using provided version type: ${versionType}`);
    } else {
      console.error(`❌ Invalid version type: ${providedType}. Must be 'patch', 'minor', or 'major'.`);
      process.exit(1);
    }
  } else {
    versionType = await promptVersionType();
  }
  
  rl.close();

  try {
    console.log(`\nIncrementing ${versionType} version...`);
    // note: This will automatically create a git tag with the new version number

    const output = execSync(`npm version ${versionType}`, { encoding: 'utf8' });
    const newVersion = output.trim();
    console.log(`Version updated to ${newVersion}`);

    console.log('Pushing tags to origin...');
    execSync(`git push origin tag ${newVersion}`, { stdio: 'inherit' });

    console.log(`Successfully released ${newVersion}!`);

  } catch (error) {
    console.error('❌ Error during release process:', error.message);
    process.exit(1);
  }
}

main().catch(console.error);
