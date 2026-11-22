import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import * as bitcoinjs from 'bitcoinjs-lib';
import { useContainer } from 'class-validator';
import { readFileSync } from 'fs';
import * as ecc from 'tiny-secp256k1';

import { AppModule } from './app.module';
import { validatorContainer } from './models/validators/validator-container';
import { ShareWindowService } from './ORM/share-window/share-window.service';
import { StratumV1Service } from './services/stratum-v1.service';
import { FoundBlocksService } from './splash/found-blocks';
import { shutdownHandler } from './splash/shutdown';
import { RoundService } from './splash/site/round.service';

async function bootstrap() {

  if (process.env.API_PORT == null) {
    console.error('It appears your environment is not configured, create and populate an .env file.');
    return;
  }

  let options = {};
  const secure = process.env.API_SECURE?.toLowerCase() == 'true';
  if (secure) {
    const currentDirectory = process.cwd();
    options = {
      https: {
        key: readFileSync(`${currentDirectory}/secrets/key.pem`),
        cert: readFileSync(`${currentDirectory}/secrets/cert.pem`),
      }
    };
  }

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(options));
  app.setGlobalPrefix('api')
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      //forbidNonWhitelisted: true,
      //forbidUnknownValues: true
    }),
  );

  const stop = shutdownHandler(
    () => app.get(StratumV1Service, { strict: false }).stopIntake(),
    [
      () => app.get(FoundBlocksService, { strict: false }).stop(),
      () => app.get(ShareWindowService, { strict: false }).onApplicationShutdown(),
      () => app.get(RoundService, { strict: false }).onApplicationShutdown(),
      // Again: a share received before the stop can turn out to be a block during the saves.
      () => app.get(FoundBlocksService, { strict: false }).stop(),
    ],
  );
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  app.enableCors();
  useContainer(validatorContainer(app.select(AppModule)), { fallback: true, fallbackOnErrors: true });

  //Taproot
  bitcoinjs.initEccLib(ecc);

  // Splash: the API is only for this machine (the site gatekeeper on 3340 and
  // local tools). Set API_HOST=0.0.0.0 to expose it on the network on purpose.
  const apiHost = process.env.API_HOST || '127.0.0.1';
  await app.listen(process.env.API_PORT, apiHost, (err, address) => {
    console.log(`API listening on ${address}`);
  });

}

bootstrap();
