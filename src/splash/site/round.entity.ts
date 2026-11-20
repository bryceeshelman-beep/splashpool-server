import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// Splash Pool "tank": pool work per round. A round runs from one accepted
// pool block to the next. The open round has endedAt = null.
@Entity()
export class SplashRoundEntity {

    @PrimaryGeneratedColumn()
    id: number;

    // Unix ms.
    @Column({ type: 'integer' })
    startedAt: number;

    @Column({ type: 'integer', nullable: true })
    endedAt: number | null;

    // Summed accepted share difficulty in this round.
    @Column({ type: 'real', default: 0 })
    work: number;

    // The pool block that ended this round (blocks_entity id and height).
    @Column({ type: 'integer', nullable: true })
    blockId: number | null;

    @Column({ type: 'integer', nullable: true })
    height: number | null;
}
