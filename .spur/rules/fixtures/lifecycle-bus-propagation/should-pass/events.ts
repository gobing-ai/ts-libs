// Fixture-local event map for the should-pass (shape 1) fixture.
export interface DemoEvents {
    [event: string]: (...args: never[]) => void;
    'demo.started': (payload: { id: string }) => void;
    'demo.stopped': (payload: { id: string }) => void;
}
