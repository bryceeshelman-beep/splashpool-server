// Stop without losing credited work: stop taking shares, save what is only in
// memory (up to 10 s of it), then exit. Without this, every restart lost it.
// Whatever stops the pool must wait longer: systemd (90 s here), Docker
// (stop_grace_period in the compose files; its default is only 10 s).
export const SAVE_TIMEOUT_MS = 15_000;

export function shutdownHandler(
    stopIntake: () => void,
    saves: (() => Promise<void>)[],
    exit: (code: number) => void = process.exit,
    timeoutMs: number = SAVE_TIMEOUT_MS,
): () => Promise<void> {
    let stopping = false;
    return async () => {
        if (stopping) {
            return; // A second signal must not cut the save short.
        }
        stopping = true;
        console.log('Stopping services');
        const timer = setTimeout(() => {
            console.error('Splash: save on shutdown timed out, exiting without it');
            exit(1);
        }, timeoutMs);
        try {
            stopIntake();
        } catch (e) {
            console.error('Splash: could not stop Stratum cleanly', e);
        }
        // A share whose reply was already written gets recorded in this turn.
        await new Promise(resolve => setImmediate(resolve));
        let code = 0;
        for (const save of saves) {
            try {
                await save();
            } catch (e) {
                code = 1;
                console.error('Splash: save on shutdown failed', e);
            }
        }
        clearTimeout(timer);
        exit(code);
    };
}
