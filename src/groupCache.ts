import { readFile } from 'fs';
import { execFile } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import * as equal from 'deep-equal';
import { ResourceManagementClient } from 'azure-arm-resource';
import { ServiceClientCredentials } from 'ms-rest';

import { Event, EventEmitter, Disposable } from 'vscode';

import { Subscription, SubscriptionWatcher } from './subscriptionWatcher';
import { LoginWatcher } from './loginWatcher';
import { UIError } from './utils';

export interface Group {
    id: string;
    name: string;
}

export class GroupCache implements Disposable {

    private current: { [subscriptionId: string]: Promise<Group[]>; } = {};
    private updates: { [subscriptionId: string]: Promise<Group[]>; } = {};

    private defaultSubscription: Subscription | undefined;

    private disposables: Disposable[] = [];

    constructor(private loginWatcher: LoginWatcher, private subscriptionWatcher: SubscriptionWatcher) {
        this.disposables.push(subscriptionWatcher.onUpdated(() => this.onSubscriptionUpdated()))
        this.onSubscriptionUpdated()
    }

    private onSubscriptionUpdated() {
        const defaultSubscription = this.subscriptionWatcher.subscriptions.find(s => s.isDefault);
        if ((this.defaultSubscription && this.defaultSubscription.id) !== (defaultSubscription && defaultSubscription.id)) {
            this.defaultSubscription = defaultSubscription;
            if (defaultSubscription) {
                const credentials = this.loginWatcher.lookupCredentials(defaultSubscription.tenantId);
                if (credentials) {
                    this.updateGroups(credentials, defaultSubscription);
                }
            }
        }
    }

    async fetchGroups() {
        if (!this.defaultSubscription) {
            throw new UIError('Not logged in, use "az login" to do so.');
        }
        const credentials = this.loginWatcher.lookupCredentials(this.defaultSubscription.tenantId);
        if (!credentials) {
            throw new UIError('Not logged in, use "az login" to do so.');
        }
        return this.updateGroups(credentials, this.defaultSubscription);
    }

    private async updateGroups(credentials: ServiceClientCredentials, subscription: Subscription): Promise<Group[]> {

        let update = this.updates[subscription.id];
        if (!update) {

            update = this.loadGroups(credentials, subscription);
            this.updates[subscription.id] = update;

            update.then(groups => {
                delete this.updates[subscription.id];
                this.current[subscription.id] = update;
            }, err => {
                delete this.updates[subscription.id];
                console.error(err);
            });
        }

        const current = this.current[subscription.id];
        if (current) {
            return Promise.race([new Promise<Group[]>(resolve => setTimeout(resolve, 500, current)), update.catch(() => current)]);
        }
        return update;
    }

    private async loadGroups(credentials: ServiceClientCredentials, subscription: Subscription): Promise<Group[]> {
        const client = new ResourceManagementClient(credentials, subscription.id);
        const groups = await client.resourceGroups.list();
        return groups as Group[];
    }

    private loadGroupsOld(subscriptionId: string): Promise<Group[]> {
        return new Promise((resolve, reject) => {
            execFile('az', ['group', 'list'], (err, stdout, stderr) => {
                if (err || stderr) {
                    reject(err || stderr);
                } else {
                    const groups: Group[] = JSON.parse(stdout);
                    const filtered: Group[] = groups.filter(group => group.id.startsWith(`/subscriptions/${subscriptionId}/`));
                    if (groups.length && !filtered.length) {
                        reject('Subscription changed');
                    } else {
                        resolve(filtered);
                    }
                }
            });
        });
    }

    dispose() {
        this.disposables.forEach(d => d.dispose());
    }
}
