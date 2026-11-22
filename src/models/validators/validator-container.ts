import { INestApplicationContext } from '@nestjs/common';

/**
 * The container class-validator asks for a validator on every single check.
 * Only our own validators are Nest providers. For the built-in ones Nest
 * throws, and building that exception was about half the CPU of a share, so
 * each class is looked up once. A miss returns undefined, and class-validator
 * then uses its own instance (useContainer's `fallback`).
 */
export function validatorContainer(context: Pick<INestApplicationContext, 'get'>) {
    const resolved = new Map<any, any>();
    return {
        get(type: any) {
            if (!resolved.has(type)) {
                let instance: any;
                try {
                    instance = context.get(type);
                } catch {
                    instance = undefined;
                }
                resolved.set(type, instance);
            }
            return resolved.get(type);
        },
    };
}
