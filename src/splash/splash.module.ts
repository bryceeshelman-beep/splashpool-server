import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { PayoutService } from './payout.service';

@Global()
@Module({
    imports: [ConfigModule],
    providers: [PayoutService],
    exports: [PayoutService],
})
export class SplashModule { }
