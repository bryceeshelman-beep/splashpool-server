import { Controller, Get, Param } from '@nestjs/common';

import { poolStatsFrom } from './pool-stats';
import { SiteService } from './site.service';

// Read-only endpoints for the public website. Only /api/site/* is exposed
// through the Cloudflare tunnel (see tools/site-proxy.js).
@Controller('site')
export class SiteController {

    constructor(private readonly siteService: SiteService) { }

    @Get('summary')
    summary() {
        return this.siteService.summary();
    }

    // Aggregate stats for pool-listing sites (MiningPoolStats). No addresses.
    @Get('poolstats')
    async poolStats() {
        return poolStatsFrom(await this.siteService.summary());
    }

    @Get('blocks')
    blocks() {
        return this.siteService.blockList();
    }

    @Get('block/:height')
    block(@Param('height') height: string) {
        return this.siteService.block(Number(height));
    }

    @Get('address/:address')
    address(@Param('address') address: string) {
        return this.siteService.address(address);
    }
}
