import { Subject } from 'rxjs'
import { Indexer, Tip } from '@ckb-lumos/indexer'
import CommonUtils from 'utils/common'
import RpcService from 'services/rpc-service'
import TransactionWithStatus from 'models/chain/transaction-with-status'
import { Address } from 'database/address/address-dao'
import AddressMeta from 'database/address/meta'
import IndexerCacheService from './indexer-cache-service'
import IndexerTxHashCache from 'database/chain/entities/indexer-tx-hash-cache'

export default class IndexerConnector {
  private indexer: Indexer
  private rpcService: RpcService
  private stop: boolean = true
  private addressesMetas: AddressMeta[] = []
  public blockTipSubject: Subject<Tip> = new Subject<Tip>()
  public transactionsSubject: Subject<Array<TransactionWithStatus>> = new Subject<Array<TransactionWithStatus>>()

  constructor(addresses: Address[], nodeUrl: string, indexerFolderPath: string) {
    this.indexer = new Indexer(nodeUrl, indexerFolderPath)
    this.rpcService = new RpcService(nodeUrl)
    this.addressesMetas = addresses.map(address => AddressMeta.fromObject(address))
  }

  public async connect() {
    this.indexer.startForever()
    this.stop = false

    while (!this.stop) {
      const lastIndexerTip = this.indexer.tip()
      this.blockTipSubject.next(lastIndexerTip)

      await this.upsertTxHashes()

      const txsInNextUnprocessedBlockNumber = await this.getTxsInNextUnprocessedBlockNumber()
      if (txsInNextUnprocessedBlockNumber.length) {
        this.transactionsSubject.next(txsInNextUnprocessedBlockNumber)
      }

      await CommonUtils.sleep(5000)
    }
  }

  private async getTxsInNextUnprocessedBlockNumber() {
    const txHashCachesByNextBlockNumberAndAddress = await Promise.all(
      this.addressesMetas.map(async addressMeta => {
        const indexerCacheService = new IndexerCacheService(addressMeta, this.rpcService)
        return indexerCacheService.nextUnprocessedTxsGroupedByBlockNumber()
      })
    )

    const groupedTxHashCaches = txHashCachesByNextBlockNumberAndAddress
      .flat()
      .sort((a, b) => a.blockTimestamp.getTime() - b.blockTimestamp.getTime())
      .reduce((grouped, txHashCache) => {
        if (!grouped.get(txHashCache.blockNumber)) {
          grouped.set(txHashCache.blockNumber, [])
        }
        grouped.get(txHashCache.blockNumber)!.push(txHashCache)

        return grouped
      }, new Map<string, Array<IndexerTxHashCache>>())

    const nextUnprocessedBlockNumber = [...groupedTxHashCaches.keys()]
      .sort((a, b) => parseInt(a) - parseInt(b))
      .shift()

    if (!nextUnprocessedBlockNumber) {
      return []
    }

    const txHashCachesInNextUnprocessedBlockNumber = groupedTxHashCaches.get(nextUnprocessedBlockNumber)
    const txsInNextUnprocessedBlockNumber = await this.fetchTxsWithStatus(
      txHashCachesInNextUnprocessedBlockNumber!.map(({txHash}) => txHash)
    )

    return txsInNextUnprocessedBlockNumber
  }

  private async upsertTxHashes() {
    await Promise.all(
      this.addressesMetas.map(async addressMeta => {
        const defaultLockScript = addressMeta.generateDefaultLockScript()

        const txHashes = this.indexer.getTransactionsByLockScript({
          code_hash: defaultLockScript.codeHash,
          hash_type: defaultLockScript.hashType,
          args: defaultLockScript.args
        })

        if (!txHashes) {
          return []
        }

        const indexerCacheService = new IndexerCacheService(addressMeta, this.rpcService)
        await indexerCacheService.upsertTxHashes(txHashes, defaultLockScript)
      })
    )
  }

  private async fetchTxsWithStatus(txHashes: string[]) {
    return await Promise.all(
      txHashes.map(async hash => {
        const txWithStatus = await this.rpcService.getTransaction(hash)
        if (!txWithStatus) {
          throw new Error(`failed to fetch transaction for hash ${hash}`)
        }
        const blockHeader = await this.rpcService.getHeader(txWithStatus!.txStatus.blockHash!)
        txWithStatus!.transaction.blockNumber = blockHeader?.number
        txWithStatus!.transaction.blockHash = txWithStatus!.txStatus.blockHash!
        txWithStatus!.transaction.timestamp = blockHeader?.timestamp
        return txWithStatus
      })
    )
  }

  // public async notifyTxsProcessed(blockNumber: string) {
    //get txhashes from map by blockNumber
    //update isProcessed for the addresses
  // }
}
