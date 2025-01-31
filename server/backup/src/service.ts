//
// Copyright © 2024 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import {
  BaseWorkspaceInfo,
  DOMAIN_TX,
  getWorkspaceId,
  Hierarchy,
  ModelDb,
  SortingOrder,
  systemAccountEmail,
  type BackupClient,
  type Branding,
  type Client,
  type MeasureContext,
  type Tx,
  type WorkspaceIdWithUrl
} from '@hcengineering/core'
import { PlatformError, unknownError } from '@hcengineering/platform'
import { listAccountWorkspaces } from '@hcengineering/server-client'
import {
  BackupClientOps,
  SessionDataImpl,
  type DbConfiguration,
  type Pipeline,
  type PipelineFactory,
  type StorageAdapter
} from '@hcengineering/server-core'
import { backup } from '.'
import { createStorageBackupStorage } from './storage'
export interface BackupConfig {
  AccountsURL: string
  Token: string

  Interval: number // Timeout in seconds
  Timeout: number // Timeout in seconds
  BucketName: string
  SkipWorkspaces: string
}

class BackupWorker {
  constructor (
    readonly storageAdapter: StorageAdapter,
    readonly config: BackupConfig,
    readonly pipelineFactory: PipelineFactory,
    readonly workspaceStorageAdapter: StorageAdapter,
    readonly getConfig: (
      ctx: MeasureContext,
      workspace: WorkspaceIdWithUrl,
      branding: Branding | null,
      externalStorage: StorageAdapter
    ) => DbConfiguration
  ) {}

  canceled = false
  interval: any

  async close (): Promise<void> {
    this.canceled = true
    clearTimeout(this.interval)
  }

  backupPromise: Promise<void> | undefined

  printStats (
    ctx: MeasureContext,
    stats: { failedWorkspaces: BaseWorkspaceInfo[], processed: number, skipped: number }
  ): void {
    ctx.warn(
      `****************************************
      backup statistics:`,
      {
        backuped: stats.processed,
        notChanges: stats.skipped,
        failed: stats.failedWorkspaces.length
      }
    )
  }

  async triggerBackup (ctx: MeasureContext): Promise<void> {
    const { failedWorkspaces } = await this.backup(ctx)
    if (failedWorkspaces.length > 0) {
      ctx.info('Failed to backup workspaces, Retry failed workspaces once.', { failed: failedWorkspaces.length })
      this.printStats(ctx, await this.doBackup(ctx, failedWorkspaces))
    }
  }

  async schedule (ctx: MeasureContext): Promise<void> {
    console.log('schedule timeout for', this.config.Interval, ' seconds')
    this.interval = setTimeout(() => {
      if (this.backupPromise !== undefined) {
        void this.backupPromise.then(() => {
          void this.triggerBackup(ctx)
        })
      }
      void this.triggerBackup(ctx)
    }, this.config.Interval * 1000)
  }

  async backup (
    ctx: MeasureContext
  ): Promise<{ failedWorkspaces: BaseWorkspaceInfo[], processed: number, skipped: number }> {
    const workspacesIgnore = new Set(this.config.SkipWorkspaces.split(';'))
    const workspaces = (await listAccountWorkspaces(this.config.Token)).filter((it) => {
      return !workspacesIgnore.has(it.workspace)
    })
    workspaces.sort((a, b) => b.lastVisit - a.lastVisit)
    return await this.doBackup(ctx, workspaces)
  }

  async doBackup (
    rootCtx: MeasureContext,
    workspaces: BaseWorkspaceInfo[]
  ): Promise<{ failedWorkspaces: BaseWorkspaceInfo[], processed: number, skipped: number }> {
    let index = 0

    const failedWorkspaces: BaseWorkspaceInfo[] = []
    let processed = 0
    for (const ws of workspaces) {
      if (this.canceled) {
        return { failedWorkspaces, processed, skipped: workspaces.length - processed }
      }
      index++
      rootCtx.warn('\n\nBACKUP WORKSPACE ', {
        workspace: ws.workspace,
        index,
        total: workspaces.length
      })
      const childLogger = rootCtx.logger.childLogger?.(ws.workspace, {
        workspace: ws.workspace,
        enableConsole: 'true'
      })
      const ctx = rootCtx.newChild(ws.workspace, { workspace: ws.workspace }, {}, childLogger)
      let pipeline: Pipeline | undefined
      try {
        const storage = await createStorageBackupStorage(
          ctx,
          this.storageAdapter,
          getWorkspaceId(this.config.BucketName),
          ws.workspace
        )
        const wsUrl: WorkspaceIdWithUrl = {
          name: ws.workspace,
          workspaceName: ws.workspaceName ?? '',
          workspaceUrl: ws.workspaceUrl ?? ''
        }
        processed += (await ctx.with(
          'backup',
          { workspace: ws.workspace },
          async (ctx) =>
            await backup(ctx, '', getWorkspaceId(ws.workspace), storage, {
              skipDomains: [],
              force: false,
              recheck: false,
              timeout: this.config.Timeout * 1000,
              connectTimeout: 5 * 60 * 1000, // 5 minutes to,
              blobDownloadLimit: 100,
              skipBlobContentTypes: [],
              storageAdapter: this.workspaceStorageAdapter,
              getLastTx: async (): Promise<Tx | undefined> => {
                const config = this.getConfig(ctx, wsUrl, null, this.workspaceStorageAdapter)
                const adapterConf = config.adapters[config.domains[DOMAIN_TX]]
                const hierarchy = new Hierarchy()
                const modelDb = new ModelDb(hierarchy)
                const txAdapter = await adapterConf.factory(
                  ctx,
                  hierarchy,
                  adapterConf.url,
                  wsUrl,
                  modelDb,
                  this.workspaceStorageAdapter
                )
                try {
                  await txAdapter.init?.()

                  return (
                    await txAdapter.rawFindAll<Tx>(
                      DOMAIN_TX,
                      {},
                      { limit: 1, sort: { modifiedOn: SortingOrder.Descending } }
                    )
                  ).shift()
                } finally {
                  await txAdapter.close()
                }
              },
              getConnection: async () => {
                if (pipeline === undefined) {
                  pipeline = await this.pipelineFactory(ctx, wsUrl, true, () => {}, null)
                }
                return this.wrapPipeline(ctx, pipeline, wsUrl)
              }
            })
        ))
          ? 1
          : 0
      } catch (err: any) {
        rootCtx.error('\n\nFAILED to BACKUP', { workspace: ws.workspace, err })
        failedWorkspaces.push(ws)
        await childLogger?.close()
      } finally {
        if (pipeline !== undefined) {
          await pipeline.close()
        }
      }
    }
    return { failedWorkspaces, processed, skipped: workspaces.length - processed }
  }

  wrapPipeline (ctx: MeasureContext, pipeline: Pipeline, wsUrl: WorkspaceIdWithUrl): Client & BackupClient {
    const contextData = new SessionDataImpl(
      systemAccountEmail,
      'backup',
      true,
      { targets: {}, txes: [] },
      wsUrl,
      null,
      false,
      new Map(),
      new Map(),
      pipeline.context.modelDb
    )
    ctx.contextData = contextData
    if (pipeline.context.lowLevelStorage === undefined) {
      throw new PlatformError(unknownError('Low level storage is not available'))
    }
    const backupOps = new BackupClientOps(pipeline.context.lowLevelStorage)

    return {
      findAll: async (_class, query, options) => {
        return await pipeline.findAll(ctx, _class, query, options)
      },
      findOne: async (_class, query, options) => {
        return (await pipeline.findAll(ctx, _class, query, { ...options, limit: 1 })).shift()
      },
      clean: async (domain, docs) => {
        await backupOps.clean(ctx, domain, docs)
      },
      close: async () => {},
      closeChunk: async (idx) => {
        await backupOps.closeChunk(ctx, idx)
      },
      getHierarchy: () => {
        return pipeline.context.hierarchy
      },
      getModel: () => {
        return pipeline.context.modelDb
      },
      loadChunk: async (domain, idx, recheck) => {
        return await backupOps.loadChunk(ctx, domain, idx, recheck)
      },
      loadDocs: async (domain, docs) => {
        return await backupOps.loadDocs(ctx, domain, docs)
      },
      upload: async (domain, docs) => {
        await backupOps.upload(ctx, domain, docs)
      },
      searchFulltext: async (query, options) => {
        return {
          docs: [],
          total: 0
        }
      },
      sendForceClose: async () => {},
      tx: async (tx) => {
        return {}
      },
      notify: (...tx) => {}
    }
  }
}

export function backupService (
  ctx: MeasureContext,
  storage: StorageAdapter,
  config: BackupConfig,
  pipelineFactory: PipelineFactory,
  workspaceStorageAdapter: StorageAdapter,
  getConfig: (
    ctx: MeasureContext,
    workspace: WorkspaceIdWithUrl,
    branding: Branding | null,
    externalStorage: StorageAdapter
  ) => DbConfiguration
): () => void {
  const backupWorker = new BackupWorker(storage, config, pipelineFactory, workspaceStorageAdapter, getConfig)

  const shutdown = (): void => {
    void backupWorker.close()
  }

  void backupWorker.backup(ctx).then((res) => {
    backupWorker.printStats(ctx, res)
    void backupWorker.schedule(ctx)
  })
  return shutdown
}
