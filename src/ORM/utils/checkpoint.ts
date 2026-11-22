import { DataSource } from 'typeorm';

/**
 * With synchronous = NORMAL a commit is only safe from a power cut once
 * checkpointed. True if everything committed so far now is.
 */
export async function checkpointDatabase(dataSource: DataSource): Promise<boolean> {
    const [{ busy, log, checkpointed }] = await dataSource.query('PRAGMA wal_checkpoint(PASSIVE)');
    return busy === 0 && checkpointed === log;
}
