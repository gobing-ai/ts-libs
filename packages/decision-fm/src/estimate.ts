/**
 * Probability estimation from repeated samples (task 0084 R6, ADR-030,
 * design § Probability estimation). Every probability is an empirical sample
 * frequency — never a self-reported confidence — so the resolution limit is
 * 1/k and `confidence` measures how much the k samples agreed, not calibration.
 */
import type { ChoiceAnswer, Desc, NoulAnswer, ScoreAnswer } from '@gobing-ai/ts-ai-runner';
/**
 * Laya reference `confidence_from_probs` on the empirical distribution:
 * `1 − H(p) / ln(n)` over the n declared options. One-hot ⇒ 1, uniform ⇒ 0.
 */
export function entropyConfidence(probabilities: number[]): number {
    const n = probabilities.length;
    if (n <= 1) return 1;
    let entropy = 0;
    for (const p of probabilities) {
        if (p > 0) entropy -= p * Math.log(p);
    }
    return 1 - entropy / Math.log(n);
}

/**
 * Choice frequencies over every supplied label (unsampled ⇒ 0). The answer
 * label is the most frequent with ties broken by label declaration order.
 */
export function estimateChoice(labels: readonly string[], samples: readonly string[]): ChoiceAnswer<string> {
    const counts = new Map<string, number>(labels.map((label) => [label, 0]));
    for (const sample of samples) counts.set(sample, (counts.get(sample) ?? 0) + 1);
    const k = samples.length;
    const probabilities: Record<string, number> = {};
    const distribution: number[] = [];
    let bestLabel = labels[0] ?? '';
    let bestCount = -1;
    for (const label of labels) {
        const count = counts.get(label) ?? 0;
        const probability = count / k;
        distribution.push(probability);
        probabilities[label] = probability;
        // Declaration order wins ties: strict `>` keeps the earlier label.
        if (count > bestCount) {
            bestCount = count;
            bestLabel = label;
        }
    }
    return {
        kind: 'choice',
        label: bestLabel,
        confidence: entropyConfidence(distribution),
        probabilities,
    };
}

/**
 * Score frequencies over the level indices `0…n-1`. The answer score is the
 * most frequent level with ties going to the lower level; the legend maps each
 * index back to its rubric description.
 */
export function estimateScore(rubric: readonly Desc[], samples: readonly string[]): ScoreAnswer {
    const k = samples.length;
    const counts: number[] = [];
    for (const sample of samples) {
        const level = Number.parseInt(sample, 10);
        counts[level] = (counts[level] ?? 0) + 1;
    }
    const probabilities: Record<number, number> = {};
    const distribution: number[] = [];
    let bestLevel = 0;
    let bestCount = -1;
    for (let level = 0; level < rubric.length; level++) {
        const count = counts[level] ?? 0;
        const probability = count / k;
        distribution.push(probability);
        probabilities[level] = probability;
        // Lower level wins ties: strict `>` keeps the smaller index.
        if (count > bestCount) {
            bestCount = count;
            bestLevel = level;
        }
    }
    const legend: Record<number, Desc> = {};
    rubric.forEach((desc, level) => {
        legend[level] = desc;
    });
    return {
        kind: 'score',
        score: bestLevel,
        confidence: entropyConfidence(distribution),
        legend,
        probabilities,
    };
}

/** Noul is a bare yes-probability — no `confidence` key, by contract. */
export function estimateNoul(samples: readonly string[]): NoulAnswer {
    const yes = samples.filter((sample) => sample === 'yes').length;
    return { kind: 'noul', probability: yes / samples.length };
}
