import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { checkpointDatabase } from '../utils/checkpoint';
import { BlocksEntity } from './blocks.entity';


@Injectable()
export class BlocksService {

    constructor(

        private dataSource: DataSource,
        @InjectRepository(BlocksEntity)
        private blocksRepository: Repository<BlocksEntity>,
    ) {

    }


    public async save(block: Partial<BlocksEntity>) {
        // No transaction: see ShareWindowService.flushLocked.
        await this.blocksRepository.save(block, { transaction: false });
    }

    /**
     * Saves a block unless one with the same header is already stored at that
     * height; true if it was added. Callers must not overlap calls for one block.
     */
    public async saveOnce(block: Partial<BlocksEntity>): Promise<boolean> {
        const stored = await this.blocksRepository.find({ where: { height: block.height }, withDeleted: true });
        if (stored.some(b => b.blockData.slice(0, 160) === block.blockData.slice(0, 160))) {
            return false;
        }
        await this.save(block);
        return true;
    }

    /** True if every block row committed so far is safe from a power cut. */
    public async checkpoint(): Promise<boolean> {
        return await checkpointDatabase(this.dataSource);
    }

    public async getFoundBlocks() {
        return await this.blocksRepository.find({
            select: {
                height: true,
                minerAddress: true,
                worker: true,
                sessionId: true
            }
        });
    }

    public async getFoundBlocksByAddress(address: string) {
        return await this.blocksRepository.find({
            select: {
                height: true,
                minerAddress: true,
                worker: true,
                sessionId: true
            },
            where: {
                minerAddress: address
            }
        });
    }
}