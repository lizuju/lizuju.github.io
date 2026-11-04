import { GomokuSolution } from '@algorithm.ts/gomoku';

self.onmessage = ({ data }) => {
    try {
        const engine = new GomokuSolution({
            MAX_ROW: 15,
            MAX_COL: 15,
            MAX_ADJACENT: 5,
            MAX_DISTANCE_OF_NEIGHBOR: 2
        });
        engine.init(data.history.map(({ row, col, player }) => ({ r: row, c: col, p: player })));
        self.postMessage({ move: engine.minimaxSearch(1) });
    } catch {
        self.postMessage({ error: true });
    }
};
