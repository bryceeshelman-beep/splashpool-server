import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SplashRoundEntity } from './round.entity';

// Only the round table lives here. RoundService, SiteService and SiteController
// are registered in AppModule so they share its single BitcoinRpcService.
@Global()
@Module({
    imports: [TypeOrmModule.forFeature([SplashRoundEntity])],
    exports: [TypeOrmModule],
})
export class SiteModule { }
