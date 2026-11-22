import { DataSource } from 'typeorm';

import { ClientEntity } from './client.entity';
import { ClientService } from './client.service';

// Real SQLite: the limit this guards against is SQLite's own.
describe('ClientService.insertClients', () => {
    let dataSource: DataSource;
    let service: ClientService;

    beforeEach(async () => {
        dataSource = new DataSource({ type: 'sqlite', database: ':memory:', entities: [ClientEntity], synchronize: true });
        await dataSource.initialize();
        service = new ClientService(dataSource.getRepository(ClientEntity));
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    const queue = (count: number) => Array.from({ length: count }, (_, i) => service.insert({
        address: `address${i}`,
        clientName: `worker${i}`,
        sessionId: i.toString(16).padStart(8, '0'),
        userAgent: 'test',
        startTime: new Date(),
        bestDifficulty: 0,
    }).then(client => client, () => null));

    it.each([1, 249, 250, 251, 995, 996, 2000, 5000])('saves %i clients queued together', async (count) => {
        const pending = queue(count);
        await service.insertClients();
        const saved = await Promise.all(pending);

        expect(saved.filter(c => c != null)).toHaveLength(count);
        // Each caller gets its own row back, with the columns SQLite filled in.
        saved.forEach((client, i) => {
            expect(client.address).toBe(`address${i}`);
            expect(client.createdAt).toBeInstanceOf(Date);
        });
        expect(await dataSource.getRepository(ClientEntity).count()).toBe(count);
    }, 30_000);

    it('a failed chunk fails only its own clients', async () => {
        await dataSource.getRepository(ClientEntity).insert({
            address: 'address300', clientName: 'worker300', sessionId: '0000012c', startTime: new Date(),
        });
        const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const pending = queue(750);
        await service.insertClients();
        const saved = await Promise.all(pending);

        expect(saved.slice(0, 250).every(c => c != null)).toBe(true);
        expect(saved.slice(250, 500).every(c => c == null)).toBe(true);
        expect(saved.slice(500).every(c => c != null)).toBe(true);
        expect(error).toHaveBeenCalled();
        error.mockRestore();
    });
});
