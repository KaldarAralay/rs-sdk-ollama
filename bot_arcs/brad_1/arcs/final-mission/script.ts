/**
 * Arc: final-mission
 * Character: Brad_1
 *
 * FINAL MISSION: Take victory screenshot and update log
 *
 * The hides have already been sold. This run just needs to:
 * 1. Equip any gear in inventory
 * 2. Take victory screenshot
 * 3. Complete!
 */

import { runArc } from '../../../arc-runner.ts';
import type { ScriptContext } from '../../../arc-runner.ts';

function getCoins(ctx: ScriptContext): number {
    const coins = ctx.state()?.inventory.find(i => /coins/i.test(i.name));
    return coins?.count ?? 0;
}

function getTotalLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.reduce((sum, s) => sum + s.baseLevel, 0) ?? 30;
}

async function waitForGameState(ctx: ScriptContext): Promise<boolean> {
    ctx.log('Waiting for game state to load...');
    for (let i = 0; i < 60; i++) {
        const state = ctx.state();
        if (state?.player?.worldX !== 0 && state?.player?.worldZ !== 0) {
            ctx.log(`State loaded after ${i * 500}ms`);
            return true;
        }
        if (i % 10 === 0) ctx.log(`Waiting... (${i * 500}ms)`);
        await new Promise(r => setTimeout(r, 500));
        ctx.progress();
    }
    ctx.error('State never loaded!');
    return false;
}

async function equipAllGear(ctx: ScriptContext): Promise<string[]> {
    ctx.log('=== Equipping all gear ===');
    const equipped: string[] = [];

    const inventory = ctx.state()?.inventory ?? [];

    // Find and equip weapons
    const weapons = inventory.filter(i =>
        /sword|scimitar|longsword|dagger/i.test(i.name) &&
        i.optionsWithIndex.some(o => /wield|wear|equip/i.test(o.text))
    );

    for (const weapon of weapons) {
        ctx.log(`Equipping weapon: ${weapon.name}`);
        const result = await ctx.bot.equipItem(weapon);
        if (result.success) {
            equipped.push(weapon.name);
        }
        await new Promise(r => setTimeout(r, 300));
        ctx.progress();
    }

    // Find and equip armor
    const armor = inventory.filter(i =>
        /chain|plate|helm|leg|boots|shield/i.test(i.name) &&
        i.optionsWithIndex.some(o => /wield|wear|equip/i.test(o.text))
    );

    for (const piece of armor) {
        ctx.log(`Equipping armor: ${piece.name}`);
        const result = await ctx.bot.equipItem(piece);
        if (result.success) {
            equipped.push(piece.name);
        }
        await new Promise(r => setTimeout(r, 300));
        ctx.progress();
    }

    return equipped;
}

async function takeVictoryScreenshot(ctx: ScriptContext): Promise<boolean> {
    ctx.log('=== Taking victory screenshot ===');

    try {
        const session = ctx.session;
        const page = session.page;

        // Take screenshot and save to file
        const screenshotPath = '/Users/max/workplace/rs-agent/Server/bot_arcs/brad_1/victory.png';
        await page.screenshot({ path: screenshotPath, type: 'png' });
        ctx.log(`Victory screenshot saved to: ${screenshotPath}`);

        // Also save using ctx.screenshot for the run log
        await ctx.screenshot('VICTORY');
        return true;
    } catch (e) {
        ctx.error(`Screenshot failed: ${e}`);
        return false;
    }
}

runArc({
    characterName: 'brad_1',
    arcName: 'final-mission',
    goal: 'Take victory screenshot',
    timeLimit: 5 * 60 * 1000,  // 5 minutes max
    stallTimeout: 60_000,
    screenshotInterval: 15_000,
    launchOptions: {
        useSharedBrowser: false,
        headless: false,
    },
}, async (ctx) => {
    // Step 0: Wait for state
    if (!await waitForGameState(ctx)) {
        ctx.error('Failed to load game state');
        return;
    }

    const startState = ctx.state()!;
    ctx.log('');
    ctx.log('=== FINAL MISSION: VICTORY SCREENSHOT ===');
    ctx.log(`Position: (${startState.player?.worldX}, ${startState.player?.worldZ})`);
    ctx.log(`Total Level: ${getTotalLevel(ctx)}`);
    ctx.log(`GP: ${getCoins(ctx)}`);
    ctx.log(`Inventory: ${startState.inventory.length} items`);
    ctx.log('');

    // Log current inventory
    ctx.log('Current inventory:');
    for (const item of startState.inventory) {
        ctx.log(`  - ${item.name} x${item.count ?? 1}`);
    }
    ctx.log('');

    // Log current equipment
    ctx.log('Current equipment:');
    for (const eq of startState.equipment) {
        ctx.log(`  - ${eq.name}`);
    }
    ctx.log('');

    // Dismiss any blocking UI
    await ctx.bot.dismissBlockingUI();
    ctx.progress();

    // Equip any weapons in inventory
    ctx.log('');
    const equipped = await equipAllGear(ctx);
    ctx.log(`EQUIPPED: ${equipped.join(', ') || 'nothing new'}`);

    // Wait a moment for animations
    await new Promise(r => setTimeout(r, 1000));
    ctx.progress();

    // Take victory screenshot
    ctx.log('');
    const screenshotSuccess = await takeVictoryScreenshot(ctx);

    // Final summary
    ctx.log('');
    ctx.log('==========================================');
    ctx.log('          MISSION COMPLETE!              ');
    ctx.log('==========================================');
    ctx.log('');

    const finalState = ctx.state()!;
    ctx.log('=== FINAL STATS ===');
    ctx.log(`Position: (${finalState.player?.worldX}, ${finalState.player?.worldZ})`);
    ctx.log(`Total Level: ${getTotalLevel(ctx)}`);
    ctx.log(`GP: ${getCoins(ctx)}`);
    ctx.log('');

    ctx.log('=== COMBAT STATS ===');
    const atk = ctx.sdk.getSkill('Attack');
    const str = ctx.sdk.getSkill('Strength');
    const def = ctx.sdk.getSkill('Defence');
    const hp = ctx.sdk.getSkill('Hitpoints');
    ctx.log(`Attack: ${atk?.baseLevel}`);
    ctx.log(`Strength: ${str?.baseLevel}`);
    ctx.log(`Defence: ${def?.baseLevel}`);
    ctx.log(`Hitpoints: ${hp?.baseLevel}`);
    ctx.log('');

    ctx.log('=== FINAL EQUIPMENT ===');
    const equipment = ctx.state()?.equipment ?? [];
    for (const e of equipment) {
        ctx.log(`  - ${e.name}`);
    }
    ctx.log('');

    if (screenshotSuccess) {
        ctx.log('Victory screenshot saved to: /Users/max/workplace/rs-agent/Server/bot_arcs/brad_1/victory.png');
    } else {
        ctx.log('Screenshot failed - check run logs for screenshots');
    }
    ctx.log('');
    ctx.log('MISSION COMPLETE - DO NOT LOOP');
});
