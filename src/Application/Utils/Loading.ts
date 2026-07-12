import EventEmitter from './EventEmitter';
import UIEventBus from '../UI/EventBus';

export default class Loading extends EventEmitter {
    constructor() {
        super();

        this.on('loadedSource', (sourceName, completed, toLoad) => {
            UIEventBus.dispatch('loadedSource', {
                sourceName: sourceName,
                progress: completed / toLoad,
                toLoad: toLoad,
                completed: completed,
            });
        });
        this.on('failedSource', (sourceName, completed, toLoad) => {
            UIEventBus.dispatch('failedSource', {
                sourceName: sourceName,
                progress: completed / toLoad,
                toLoad: toLoad,
                completed: completed,
            });
        });
    }
}
