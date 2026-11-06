import { createGomokuSearcher, createScoreMap, GomokuSolution } from '@algorithm.ts/gomoku';

self.onmessage = ({ data }) => {
    try {
        const scoreMap = createScoreMap(5);
        const engine = new GomokuSolution({
            MAX_ROW: 15,
            MAX_COL: 15,
            MAX_ADJACENT: 5,
            MAX_DISTANCE_OF_NEIGHBOR: 2,
            scoreMap,
            ...(data.difficulty === 'challenge' ? {
                deeperSearcher: mover => createGomokuSearcher({
                    searchContext: mover,
                    narrowSearcherOptions: [
                        { MAX_SEARCH_DEPTH: 3, MAX_CANDIDATE_COUNT: 10, MIN_PROMOTION_SCORE: scoreMap.con[2][2] * 4, CANDIDATE_GROWTH_FACTOR: 8 },
                        { MAX_SEARCH_DEPTH: 6, MAX_CANDIDATE_COUNT: 6, MIN_PROMOTION_SCORE: scoreMap.con[3][1] * 2, CANDIDATE_GROWTH_FACTOR: 8 },
                        { MAX_SEARCH_DEPTH: 10, MAX_CANDIDATE_COUNT: 3, MIN_PROMOTION_SCORE: scoreMap.con[3][2] * 4, CANDIDATE_GROWTH_FACTOR: 8 }
                    ],
                    deepSearcherOption: { MAX_SEARCH_DEPTH: 20, MIN_PROMOTION_SCORE: scoreMap.con[4][1] }
                })
            } : {})
        });
        engine.init(data.history.map(({ row, col, player }) => ({ r: row, c: col, p: player })));
        const candidate = engine.mover.topCandidate(1);
        const move = candidate ? [Math.floor(candidate.posId / 15), candidate.posId % 15] : [-1, -1];
        if (data.difficulty === 'simple') {
            self.postMessage({ move });
            return;
        }
        self.postMessage({ candidate: move });
        self.postMessage({ move: engine.minimaxSearch(1) });
    } catch {
        self.postMessage({ error: true });
    }
};
