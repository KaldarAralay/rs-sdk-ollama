import SpotAnimType from '#/config/SpotAnimType.js';

import ModelSource from '#/dash3d/ModelSource.ts';

export default class MapSpotAnim extends ModelSource {
    readonly spotType: SpotAnimType;
    readonly spotLevel: number;
    readonly x: number;
    readonly z: number;
    readonly y: number;
    readonly startCycle: number;

    // runtime
    seqComplete: boolean = false;
    seqFrame: number = 0;
    seqCycle: number = 0;

    constructor(id: number, level: number, x: number, z: number, y: number, cycle: number, delay: number) {
        super();

        this.spotType = SpotAnimType.types[id];
        this.spotLevel = level;
        this.x = x;
        this.z = z;
        this.y = y;
        this.startCycle = cycle + delay;
    }

    update(delta: number): void {
        if (!this.spotType.seq || !this.spotType.seq.delay) {
            return;
        }

        for (this.seqCycle += delta; this.seqCycle > this.spotType.seq.delay[this.seqFrame]; ) {
            this.seqCycle -= this.spotType.seq.delay[this.seqFrame] + 1;
            this.seqFrame++;

            if (this.seqFrame >= this.spotType.seq.frameCount) {
                this.seqFrame = 0;
                this.seqComplete = true;
            }
        }
    }
}
