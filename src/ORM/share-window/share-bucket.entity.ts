import { Column, Entity, PrimaryColumn } from 'typeorm';

// Splash Pool: accepted share work per payout address, bucketed per minute.
// One row per (address, minute). `difficulty` is the summed share difficulty
// credited in that minute; `shares` is the count of accepted shares.
@Entity()
export class ShareBucketEntity {

    @PrimaryColumn({ length: 90, type: 'varchar' })
    address: string;

    // Unix time in whole minutes (Math.floor(ms / 60000)).
    @PrimaryColumn({ type: 'integer' })
    bucket: number;

    @Column({ type: 'real', default: 0 })
    difficulty: number;

    @Column({ type: 'integer', default: 0 })
    shares: number;
}
