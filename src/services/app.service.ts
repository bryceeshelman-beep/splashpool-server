import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { RpcBlockService } from '../ORM/rpc-block/rpc-block.service';
import { checkpointDatabase } from '../ORM/utils/checkpoint';

const CHECKPOINT_INTERVAL_MS = 10 * 1000;

@Injectable()
export class AppService implements OnModuleInit {

    private checkpointing = false;
    private checkpointFailing = false;

    constructor(
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly clientService: ClientService,
        private readonly dataSource: DataSource,
        private readonly rpcBlockService: RpcBlockService,
    ) {

    }

    async onModuleInit() {
        // if (process.env.NODE_APP_INSTANCE == '0') {
        //     await this.dataSource.query(`VACUUM;`);
        // }

        //https://phiresky.github.io/blog/2020/sqlite-performance-tuning/
        // //500 MB DB cache
        // await this.dataSource.query(`PRAGMA cache_size = -500000;`);
        // Splash Pool: in WAL mode NORMAL can't corrupt the database on power loss,
        // but loses commits since the last checkpoint: hence one every 10 s. Found
        // blocks don't rely on it, they have fsynced files (found-blocks.ts).
        await this.dataSource.query(`PRAGMA synchronous = NORMAL;`);
        // //6Gb
        // await this.dataSource.query(`PRAGMA mmap_size = 6000000000;`);

        if (process.env.NODE_APP_INSTANCE == null || process.env.NODE_APP_INSTANCE == '0') {

            setInterval(() => void this.checkpoint(), CHECKPOINT_INTERVAL_MS);

            setInterval(async () => {
                await this.deleteOldStatistics();
            }, 1000 * 60 * 60);

            setInterval(async () => {
                console.log('Killing dead clients');
                await this.clientService.killDeadClients();
            }, 1000 * 60 * 5);

            setInterval(async () => {
                console.log('Deleting Old Blocks');
                await this.rpcBlockService.deleteOldBlocks();
            }, 1000 * 60 * 60 * 24);



        }

    }

    private async checkpoint() {
        // It waits behind long reads: don't queue more behind it.
        if (this.checkpointing) {
            return;
        }
        this.checkpointing = true;
        try {
            await checkpointDatabase(this.dataSource);
            if (this.checkpointFailing) {
                this.checkpointFailing = false;
                console.log('Splash: database checkpoints working again');
            }
        } catch (e) {
            if (!this.checkpointFailing) {
                this.checkpointFailing = true;
                console.error('Splash: database checkpoint failed, retrying every 10 s', e);
            }
        } finally {
            this.checkpointing = false;
        }
    }

    private async deleteOldStatistics() {
        console.log('Deleting statistics');

        const deletedStatistics = await this.clientStatisticsService.deleteOldStatistics();
        console.log(`Deleted ${deletedStatistics.affected} old statistics`);
        const deletedClients = await this.clientService.deleteOldClients();
        console.log(`Deleted ${deletedClients.affected} old clients`);

    }


}