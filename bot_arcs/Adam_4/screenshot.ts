/**
 * Simple screenshot and stats script for Adam_4
 */

import { launchBotWithSDK, sleep } from '../../test/utils/browser';
import type { SDKSession } from '../../test/utils/browser';

const BOT_NAME = 'adam_4';

async function main() {
    console.log('=== ADAM_4 SCREENSHOT ===');

    let session: SDKSession | null = null;

    try {
        console.log(`Launching bot ${BOT_NAME}...`);
        session = await launchBotWithSDK(BOT_NAME, {
            headless: false,
            skipTutorial: false,
            useSharedBrowser: false,
        });

        const { sdk, bot, page } = session;

        // Wait for state
        console.log('Waiting for game state...');
        await sleep(5000);

        // Wait for position
        let attempts = 0;
        while (attempts < 20) {
            const s = sdk.getState();
            if (s?.player?.worldX && s.player.worldX > 0) {
                console.log(`Position: (${s.player.worldX}, ${s.player.worldZ})`);
                break;
            }
            await sleep(500);
            attempts++;
        }

        const state = sdk.getState();
        if (!state) throw new Error('No game state');

        // Take screenshot
        await page.screenshot({
            type: 'png',
            path: '/Users/max/workplace/rs-agent/Server/bot_arcs/Adam_4/victory.png'
        });
        console.log('Screenshot saved to victory.png');

        // Log stats
        console.log('\n========== ADAM_4 FINAL STATS ==========');
        console.log(`Position: (${state.player?.worldX}, ${state.player?.worldZ})`);
        console.log(`Combat Level: ${state.player?.combatLevel}`);

        // Equipment
        console.log(`\nEquipment: ${state.equipment.map(e => e.name).join(', ') || 'None'}`);

        // Inventory
        console.log('\nInventory:');
        for (const item of state.inventory) {
            console.log(`  ${item.name} x${item.count}`);
        }

        // Gold
        const gold = state.inventory.find(i => /coin/i.test(i.name))?.count || 0;
        console.log(`\nGold: ${gold} gp`);

        // Skills
        console.log('\nSkills:');
        const skills = state.skills.filter(s => s.baseLevel > 1);
        for (const skill of skills) {
            console.log(`  ${skill.name}: ${skill.baseLevel} (${skill.experience} xp)`);
        }

        // Score calculation
        const totalLevel = state.skills.reduce((sum, s) => sum + s.baseLevel, 0);
        console.log(`\nTotal Level: ${totalLevel}`);
        console.log(`\n========== FINAL SCORE: ${totalLevel + gold} ==========`);

        // Keep open
        console.log('\nBrowser open for 10 seconds...');
        await sleep(10000);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        if (session) {
            await session.cleanup();
        }
    }
}

main().catch(console.error);
