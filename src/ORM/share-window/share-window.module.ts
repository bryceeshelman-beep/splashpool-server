import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ShareBucketEntity } from './share-bucket.entity';
import { ShareWindowService } from './share-window.service';

@Global()
@Module({
    imports: [ConfigModule, TypeOrmModule.forFeature([ShareBucketEntity])],
    providers: [ShareWindowService],
    exports: [TypeOrmModule, ShareWindowService],
})
export class ShareWindowModule { }
