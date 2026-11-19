import { BadRequestException, Controller, Get, Query } from '@nestjs/common';

import { ShareWindowService } from '../../ORM/share-window/share-window.service';
import { PayoutService } from '../../splash/payout.service';

@Controller('splash')
export class SplashController {

    constructor(
        private readonly shareWindowService: ShareWindowService,
        private readonly payoutService: PayoutService,
    ) { }

    // Current 3-day share window: work per payout address and its fraction.
    @Get('window')
    public async getWindow() {
        return await this.shareWindowService.getWindow();
    }

    // Payout settings and the age of the window snapshot jobs are built from.
    @Get('payouts/status')
    public getStatus() {
        return this.payoutService.status();
    }

    // What a block found by `finder` would pay right now, from the same
    // snapshot miners' jobs use. `reward` defaults to the latest template's.
    @Get('payouts')
    public getPayouts(@Query('finder') finder: string, @Query('reward') rewardParam?: string) {
        if (!this.payoutService.enabled) {
            throw new BadRequestException('Splash payouts are disabled');
        }
        if (!finder || !this.payoutService.isPayable(finder)) {
            throw new BadRequestException('finder must be a valid address for this network');
        }
        const reward = rewardParam != null ? Number(rewardParam) : this.payoutService.status().lastReward;
        if (!Number.isSafeInteger(reward) || reward < 0) {
            throw new BadRequestException('reward must be an integer number of sats (no template seen yet?)');
        }
        return this.payoutService.build(finder, reward);
    }
}
