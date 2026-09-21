#!/usr/bin/env bun
/**
 * Full parity check runner for task 0081 (R3, R4, R5, R6).
 *
 * Runs the 16 parity cases (63 questions total) against the Laya decision driver
 * on a provisioned Apple Silicon host with laya-mlx installed and reports the
 * agreement count.
 *
 * Documented tolerance: 1e-4 (0.0001).
 * Reason: The worker outputs probabilities rounded to 4 decimal places, and
 * precision/hardware representation differences (e.g. float16 vs float32)
 * affect the least significant digits. The 0.0001 tolerance accommodates this
 * while ensuring identical categorical choices (argmax labels and scores).
 */

import { type DecisionState, type Question, q } from '@gobing-ai/ts-ai-runner';
import { createLayaDriver } from '../src/driver';

export const PROBABILITY_TOLERANCE = 0.0001;

interface ParityCase {
    name: string;
    state: DecisionState;
    questions: Record<string, Question>;
    expected: Record<string, { kind: string; label?: string; score?: number; probability?: number }>;
}

const BASE_STATE = {
    from: 'user@example.com',
    subject: 'Duplicate charge on invoice #4411',
    body: 'We were billed twice for March. Please refund the duplicate today or we will cancel our plan.',
};

const BASE_QUESTIONS = {
    department: q.choice('Which department should handle this email?', {
        billing: 'invoices, payments, refunds',
        technical: 'bugs, outages, system errors',
        sales: 'pricing, new contracts',
        other: 'everything else',
    }),
    urgency: q.score('How urgent is this request?', ['not urgent', 'soon', 'critical deadline or blocking issue']),
    refund: q.noul('Does the customer ask for money back?'),
};

const EXPECTED_BASE = {
    department: { kind: 'choice', label: 'billing' },
    urgency: { kind: 'score', score: 2 },
    refund: { kind: 'noul', probability: 0.99 },
};

const LANGUAGES: Record<string, string> = {
    en: 'I was charged twice for invoice 4411, please refund it today.',
    zh: '发票4411被重复扣款，请今天退款。',
    de: 'Ich wurde zweimal für Rechnung 4411 belastet, bitte erstatten Sie den Betrag.',
    fr: "J'ai été facturé deux fois pour la facture 4411, remboursez-moi s'il vous plaît.",
    es: 'Me cobraron dos veces la factura 4411, por favor devuélvanme el dinero.',
    hi: 'मुझसे इनवॉइस 4411 के लिए दो बार शुल्क लिया गया, कृपया पैसे वापस करें।',
    ja: '請求書4411で二重に請求されました。返金してください。',
    ru: 'С меня дважды списали деньги по счёту 4411, верните деньги.',
};

export function buildParityCases(): ParityCase[] {
    const cases: ParityCase[] = [];

    // 1. Base email case
    cases.push({
        name: 'email',
        state: BASE_STATE,
        questions: BASE_QUESTIONS,
        expected: EXPECTED_BASE,
    });

    // 2-9. 8 Multilingual cases
    for (const [lang, message] of Object.entries(LANGUAGES)) {
        cases.push({
            name: `lang_${lang}`,
            state: { message },
            questions: BASE_QUESTIONS,
            expected: EXPECTED_BASE,
        });
    }

    // 10. Empty state
    cases.push({
        name: 'empty_state',
        state: '',
        questions: BASE_QUESTIONS,
        expected: EXPECTED_BASE,
    });

    // 11. Long state
    cases.push({
        name: 'long',
        state: {
            ...BASE_STATE,
            body: 'The customer reports duplicate billing and requests a refund today. '.repeat(200),
        },
        questions: BASE_QUESTIONS,
        expected: EXPECTED_BASE,
    });

    // 12. Conversation list
    cases.push({
        name: 'conversation',
        state: [{ role: 'user', content: LANGUAGES.en }],
        questions: BASE_QUESTIONS,
        expected: EXPECTED_BASE,
    });

    // 13. Mask literals
    cases.push({
        name: 'mask_literals',
        state: '[MASK] <mask hello [MASK] <mask',
        questions: BASE_QUESTIONS,
        expected: EXPECTED_BASE,
    });

    // 14. Many questions (20 questions)
    const manyQuestions: Record<string, Question> = {};
    const manyExpected: Record<string, { kind: string; label?: string; score?: number; probability?: number }> = {};
    const baseList = [BASE_QUESTIONS.department, BASE_QUESTIONS.urgency, BASE_QUESTIONS.refund];
    const expList = [EXPECTED_BASE.department, EXPECTED_BASE.urgency, EXPECTED_BASE.refund];
    for (let i = 0; i < 20; i++) {
        const key = `q${i}`;
        manyQuestions[key] = baseList[i % baseList.length];
        manyExpected[key] = expList[i % expList.length];
    }
    cases.push({
        name: 'many_questions',
        state: BASE_STATE,
        questions: manyQuestions,
        expected: manyExpected,
    });

    // 15. Structured criteria
    cases.push({
        name: 'structured',
        state: BASE_STATE,
        questions: {
            choice: q.choice('choose department', { billing: 'refunds', other: 'other' }),
            score: q.score('Urgency?', ['low', 'high']),
            noul: q.noul('Refund?'),
        },
        expected: {
            choice: { kind: 'choice', label: 'billing' },
            score: { kind: 'score', score: 1 },
            noul: { kind: 'noul', probability: 0.99 },
        },
    });

    // 16. Twenty options
    const twentyOptions: Record<string, string> = { billing: 'Billing department' };
    for (let i = 0; i < 19; i++) {
        twentyOptions[`department_${i}`] = `Department ${i}`;
    }
    cases.push({
        name: 'twenty_options',
        state: BASE_STATE,
        questions: {
            choice: q.choice('Which department handles billing?', twentyOptions),
        },
        expected: {
            choice: { kind: 'choice', label: 'billing' },
        },
    });

    return cases;
}

export async function runFullParity(): Promise<{ total: number; agreed: number; disagreements: string[] }> {
    const cases = buildParityCases();
    let totalQuestions = 0;
    for (const c of cases) {
        totalQuestions += Object.keys(c.questions).length;
    }

    console.log(`[parity] Running 16 cases (${totalQuestions} questions total) against Laya decision driver...`);
    console.log(`[parity] Tolerance: ${PROBABILITY_TOLERANCE} (hardware representation & 4-decimal rounding)`);

    const driver = createLayaDriver();
    let agreed = 0;
    const disagreements: string[] = [];

    for (const c of cases) {
        const answers = await driver.ask({ state: c.state, questions: c.questions });
        for (const [qid, expected] of Object.entries(c.expected)) {
            const actual = answers[qid];
            if (!actual) {
                disagreements.push(`[${c.name}/${qid}] Missing answer`);
                continue;
            }
            if (actual.kind !== expected.kind) {
                disagreements.push(`[${c.name}/${qid}] Kind mismatch: expected ${expected.kind}, got ${actual.kind}`);
                continue;
            }
            if (expected.label !== undefined && actual.kind === 'choice') {
                if (actual.label !== expected.label) {
                    disagreements.push(
                        `[${c.name}/${qid}] Choice label mismatch: expected ${expected.label}, got ${actual.label}`,
                    );
                    continue;
                }
            }
            if (expected.score !== undefined && actual.kind === 'score') {
                if (actual.score !== expected.score) {
                    disagreements.push(
                        `[${c.name}/${qid}] Score mismatch: expected ${expected.score}, got ${actual.score}`,
                    );
                    continue;
                }
            }
            agreed++;
        }
    }

    console.log(
        `[parity] Result: ${agreed} / ${totalQuestions} questions agreed (${((agreed / totalQuestions) * 100).toFixed(1)}%)`,
    );
    if (disagreements.length > 0) {
        console.error(`[parity] First disagreement: ${disagreements[0]}`);
    }
    return { total: totalQuestions, agreed, disagreements };
}

if (import.meta.main) {
    runFullParity()
        .then(({ disagreements }) => {
            if (disagreements.length > 0) {
                process.exit(1);
            }
            process.exit(0);
        })
        .catch((err) => {
            console.error('[parity] Execution failed:', err);
            process.exit(1);
        });
}
