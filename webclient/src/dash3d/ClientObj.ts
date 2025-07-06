import ObjType from '#/config/ObjType.ts';
import type Model from '#/dash3d/Model.ts';
import ModelSource from '#/dash3d/ModelSource.ts';

export default class ClientObj extends ModelSource {
    readonly index: number;
    count: number;

    constructor(index: number, count: number) {
        super();
        this.index = index;
        this.count = count;
    }

    getModel(): Model | null {
        const obj = ObjType.get(this.index);
        return obj.getModel(this.count);
    }
}
