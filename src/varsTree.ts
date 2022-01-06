export class VarsTree {
    private _root: VarsTree[] = []
    private _counter = 0
    private id: number = 0
    public name: string = ""
    constructor() {

    }

    public getId(): number {
        return this.id
    }

    public add(key: string, parent: number): number {
        const stack: VarsTree[] = [this]
        while (stack.length) {
            const node = stack.pop()
            if (node?.id == parent) {
                const child = new VarsTree()
                child.id =  ++ this._counter 
                child.name = key
                node._root.push(child)
                return child.id
            } else {
                if (node) {
                    for (const child of node?._root) {
                        stack.push(child)
                    }
                }
            }
        }
        return -1
    }

    public find(id: number): string[] {
        const stack: VarsTree[] = []
        const ret = this._findFrame(id, stack)
        if (ret) {
            stack.shift()
            const path: string[] = []
            for (const item of stack) {
                path.push(item.name)
            }
            return path
        }
        return []
    }

    public findChild(parentId: number, name: string): VarsTree {
        const stack: VarsTree[] = []
        const parent = this._findFrame(parentId, stack)
        if (parent) {
            for (const child of stack[stack.length - 1]._root) {
                if (child.name == name) {
                    return child
                }
            }
        }
        return new VarsTree()
    }

    public findFrame(id: number): number {
        const stack:VarsTree[] = []
        const ret = this._findFrame(id, stack)
        if (ret) {
            return stack[0].getId()
        }
        return -1
    }

    public _findFrame(id:number, stack:VarsTree[]): boolean {
        if (this.getId() == id) {
            return true
        }
        if (this._root) {
            for (const child of this._root) {
                if (child._findFrame(id, stack)) {
                    stack.unshift(child)
                    return true
                } 
            }
        }
        return false
    }

}