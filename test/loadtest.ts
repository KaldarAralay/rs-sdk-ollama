#!/usr/bin/env bun
/**
 * Load Test
 *
 * Spawns multiple combat training bots sharing a single browser instance.
 * Much more efficient than spawning separate browser processes.
 *
 * Usage:
 *   bun run test/loadtest.ts
 */

import { launchBotWithSDK, sleep, getSharedBrowser, releaseSharedBrowser, type SDKSession } from './utils/browser';
import { runCombatTrainingBot } from './combat-training';

const COMBAT_COUNT = 10;
const DURATION_SECONDS = 120; // 2 minutes
const STAGGER_MS = 1000; // Time between bot launches

interface BotState {
    name: string;
    session: SDKSession | null;
    promise: Promise<boolean>;
}

async function main() {
    console.log(`\n=== Load Test (Shared Browser) ===`);
    console.log(`Combat bots: ${COMBAT_COUNT}`);
    console.log(`Duration: ${DURATION_SECONDS} seconds`);
    console.log(`Mode: headless, shared browser`);
    console.log(`\nStarting bots with ${STAGGER_MS}ms stagger...\n`);

    const bots: BotState[] = [];
    const startTime = Date.now();

    // Pre-launch the shared browser
    console.log('Launching shared browser...');
    await getSharedBrowser(true);
    console.log('Shared browser ready!\n');

    // Spawn combat bots - they all share the same browser
    for (let i = 1; i <= COMBAT_COUNT; i++) {
        const botName = `combat${i.toString().padStart(2, '0')}`;
        console.log(`Starting combat bot: ${botName}`);

        const botPromise = launchAndRunBot(botName, DURATION_SECONDS);
        bots.push({
            name: botName,
            session: null,
            promise: botPromise
        });

        // Stagger spawns to avoid overwhelming the server
        if (i < COMBAT_COUNT) {
            await sleep(STAGGER_MS);
        }
    }

    console.log(`\nAll ${bots.length} bots started!`);
    console.log(`Running for ${DURATION_SECONDS} seconds...\n`);

    // Handle graceful shutdown
    let shuttingDown = false;
    process.on('SIGINT', async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log('\n\nShutting down...');
        // Let bots clean up naturally via their duration timeout
        process.exit(0);
    });

    // Wait for all bots to complete
    const results = await Promise.allSettled(bots.map(b => b.promise));

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const succeeded = results.filter(r => r.status === 'fulfilled' && r.value).length;
    const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value)).length;

    console.log(`\n=== Load Test Complete ===`);
    console.log(`Duration: ${elapsed}s`);
    console.log(`Succeeded: ${succeeded}/${COMBAT_COUNT}`);
    console.log(`Failed: ${failed}/${COMBAT_COUNT}`);

    // Release shared browser
    for (let i = 0; i < COMBAT_COUNT; i++) {
        await releaseSharedBrowser();
    }
}

async function launchAndRunBot(botName: string, durationSeconds: number): Promise<boolean> {
    try {
        const session = await launchBotWithSDK(botName, {
            headless: true,
            useSharedBrowser: true
        });

        console.log(`[${botName}] Ready, starting combat training`);

        const result = await runCombatTrainingBot(session, {
            durationSeconds,
            logPrefix: `[${botName}]`
        });

        await session.cleanup();
        return result;
    } catch (error: any) {
        console.error(`[${botName}] Error: ${error.message}`);
        return false;
    }
}

main().catch(error => {
    console.error('Load test failed:', error);
    process.exit(1);
});
