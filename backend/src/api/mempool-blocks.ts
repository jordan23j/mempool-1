import { GbtGenerator, GbtResult, ThreadTransaction as RustThreadTransaction } from '../../rust-gbt';
import logger from '../logger';
import { MempoolBlock, MempoolTransactionExtended, TransactionStripped, MempoolBlockWithTransactions, MempoolBlockDelta, Ancestor, CompactThreadTransaction, EffectiveFeeStats } from '../mempool.interfaces';
import { Common, OnlineFeeStatsCalculator } from './common';
import config from '../config';
import { Worker } from 'worker_threads';
import path from 'path';

const MAX_UINT32 = Math.pow(2, 32) - 1;

class MempoolBlocks {
  private mempoolBlocks: MempoolBlockWithTransactions[] = [];
  private mempoolBlockDeltas: MempoolBlockDelta[] = [];
  private txSelectionWorker: Worker | null = null;
  private rustInitialized: boolean = false;
  private rustGbtGenerator: GbtGenerator = new GbtGenerator();

  private nextUid: number = 1;
  private uidMap: Map<number, string> = new Map(); // map short numerical uids to full txids

  public getMempoolBlocks(): MempoolBlock[] {
    return this.mempoolBlocks.map((block) => {
      return {
        blockSize: block.blockSize,
        blockVSize: block.blockVSize,
        nTx: block.nTx,
        totalFees: block.totalFees,
        medianFee: block.medianFee,
        feeRange: block.feeRange,
      };
    });
  }

  public getMempoolBlocksWithTransactions(): MempoolBlockWithTransactions[] {
    return this.mempoolBlocks;
  }

  public getMempoolBlockDeltas(): MempoolBlockDelta[] {
    return this.mempoolBlockDeltas;
  }

  public updateMempoolBlocks(memPool: { [txid: string]: MempoolTransactionExtended }, saveResults: boolean = false): MempoolBlockWithTransactions[] {
    const latestMempool = memPool;
    const memPoolArray: MempoolTransactionExtended[] = [];
    for (const i in latestMempool) {
      memPoolArray.push(latestMempool[i]);
    }
    const start = new Date().getTime();

    // Clear bestDescendants & ancestors
    memPoolArray.forEach((tx) => {
      tx.bestDescendant = null;
      tx.ancestors = [];
      tx.cpfpChecked = false;
      if (!tx.effectiveFeePerVsize) {
        tx.effectiveFeePerVsize = tx.adjustedFeePerVsize;
      }
    });

    // First sort
    memPoolArray.sort((a, b) => {
      if (a.adjustedFeePerVsize === b.adjustedFeePerVsize) {
        // tie-break by lexicographic txid order for stability
        return a.txid < b.txid ? -1 : 1;
      } else {
        return b.adjustedFeePerVsize - a.adjustedFeePerVsize;
      }
    });

    // Loop through and traverse all ancestors and sum up all the sizes + fees
    // Pass down size + fee to all unconfirmed children
    let sizes = 0;
    memPoolArray.forEach((tx) => {
      sizes += tx.weight;
      if (sizes > 4000000 * 8) {
        return;
      }
      Common.setRelativesAndGetCpfpInfo(tx, memPool);
    });

    // Final sort, by effective fee
    memPoolArray.sort((a, b) => {
      if (a.effectiveFeePerVsize === b.effectiveFeePerVsize) {
        // tie-break by lexicographic txid order for stability
        return a.txid < b.txid ? -1 : 1;
      } else {
        return b.effectiveFeePerVsize - a.effectiveFeePerVsize;
      }
    });

    const end = new Date().getTime();
    const time = end - start;
    logger.debug('Mempool blocks calculated in ' + time / 1000 + ' seconds');

    const blocks = this.calculateMempoolBlocks(memPoolArray);

    if (saveResults) {
      const deltas = this.calculateMempoolDeltas(this.mempoolBlocks, blocks);
      this.mempoolBlocks = blocks;
      this.mempoolBlockDeltas = deltas;
    }

    return blocks;
  }

  private calculateMempoolBlocks(transactionsSorted: MempoolTransactionExtended[]): MempoolBlockWithTransactions[] {
    const mempoolBlocks: MempoolBlockWithTransactions[] = [];
    let feeStatsCalculator: OnlineFeeStatsCalculator = new OnlineFeeStatsCalculator(config.MEMPOOL.BLOCK_WEIGHT_UNITS);
    let onlineStats = false;
    let blockSize = 0;
    let blockWeight = 0;
    let blockVsize = 0;
    let blockFees = 0;
    const sizeLimit = (config.MEMPOOL.BLOCK_WEIGHT_UNITS / 4) * 1.2;
    let transactionIds: string[] = [];
    let transactions: MempoolTransactionExtended[] = [];
    transactionsSorted.forEach((tx, index) => {
      if (blockWeight + tx.weight <= config.MEMPOOL.BLOCK_WEIGHT_UNITS
        || mempoolBlocks.length === config.MEMPOOL.MEMPOOL_BLOCKS_AMOUNT - 1) {
        tx.position = {
          block: mempoolBlocks.length,
          vsize: blockVsize + (tx.vsize / 2),
        };
        blockWeight += tx.weight;
        blockVsize += tx.vsize;
        blockSize += tx.size;
        blockFees += tx.fee;
        if (blockVsize <= sizeLimit) {
          transactions.push(tx);
        }
        transactionIds.push(tx.txid);
        if (onlineStats) {
          feeStatsCalculator.processNext(tx);
        }
      } else {
        mempoolBlocks.push(this.dataToMempoolBlocks(transactionIds, transactions, blockSize, blockWeight, blockFees));
        blockVsize = 0;
        tx.position = {
          block: mempoolBlocks.length,
          vsize: blockVsize + (tx.vsize / 2),
        };

        if (mempoolBlocks.length === config.MEMPOOL.MEMPOOL_BLOCKS_AMOUNT - 1) {
          const stackWeight = transactionsSorted.slice(index).reduce((total, tx) => total + (tx.weight || 0), 0);
          if (stackWeight > config.MEMPOOL.BLOCK_WEIGHT_UNITS) {
            onlineStats = true;
            feeStatsCalculator = new OnlineFeeStatsCalculator(stackWeight, 0.5, [10, 20, 30, 40, 50, 60, 70, 80, 90]);
            feeStatsCalculator.processNext(tx);
          }
        }

        blockVsize += tx.vsize;
        blockWeight = tx.weight;
        blockSize = tx.size;
        blockFees = tx.fee;
        transactionIds = [tx.txid];
        transactions = [tx];
      }
    });
    if (transactions.length) {
      const feeStats = onlineStats ? feeStatsCalculator.getRawFeeStats() : undefined;
      mempoolBlocks.push(this.dataToMempoolBlocks(transactionIds, transactions, blockSize, blockWeight, blockFees, feeStats));
    }

    return mempoolBlocks;
  }

  private calculateMempoolDeltas(prevBlocks: MempoolBlockWithTransactions[], mempoolBlocks: MempoolBlockWithTransactions[]): MempoolBlockDelta[] {
    const mempoolBlockDeltas: MempoolBlockDelta[] = [];
    for (let i = 0; i < Math.max(mempoolBlocks.length, prevBlocks.length); i++) {
      let added: TransactionStripped[] = [];
      let removed: string[] = [];
      const changed: { txid: string, rate: number | undefined }[] = [];
      if (mempoolBlocks[i] && !prevBlocks[i]) {
        added = mempoolBlocks[i].transactions;
      } else if (!mempoolBlocks[i] && prevBlocks[i]) {
        removed = prevBlocks[i].transactions.map(tx => tx.txid);
      } else if (mempoolBlocks[i] && prevBlocks[i]) {
        const prevIds = {};
        const newIds = {};
        prevBlocks[i].transactions.forEach(tx => {
          prevIds[tx.txid] = tx;
        });
        mempoolBlocks[i].transactions.forEach(tx => {
          newIds[tx.txid] = true;
        });
        prevBlocks[i].transactions.forEach(tx => {
          if (!newIds[tx.txid]) {
            removed.push(tx.txid);
          }
        });
        mempoolBlocks[i].transactions.forEach(tx => {
          if (!prevIds[tx.txid]) {
            added.push(tx);
          } else if (tx.rate !== prevIds[tx.txid].rate) {
            changed.push({ txid: tx.txid, rate: tx.rate });
          }
        });
      }
      mempoolBlockDeltas.push({
        added,
        removed,
        changed,
      });
    }
    return mempoolBlockDeltas;
  }

  public async $makeBlockTemplates(newMempool: { [txid: string]: MempoolTransactionExtended }, saveResults: boolean = false): Promise<MempoolBlockWithTransactions[]> {
    const start = Date.now();

    // reset mempool short ids
    this.resetUids();
    for (const tx of Object.values(newMempool)) {
      this.setUid(tx);
    }

    // prepare a stripped down version of the mempool with only the minimum necessary data
    // to reduce the overhead of passing this data to the worker thread
    const strippedMempool: Map<number, CompactThreadTransaction> = new Map();
    Object.values(newMempool).forEach(entry => {
      if (entry.uid !== null && entry.uid !== undefined) {
        const stripped = {
          uid: entry.uid,
          fee: entry.fee,
          weight: (entry.adjustedVsize * 4),
          sigops: entry.sigops,
          feePerVsize: entry.adjustedFeePerVsize || entry.feePerVsize,
          effectiveFeePerVsize: entry.effectiveFeePerVsize || entry.adjustedFeePerVsize || entry.feePerVsize,
          inputs: entry.vin.map(v => this.getUid(newMempool[v.txid])).filter(uid => (uid !== null && uid !== undefined)) as number[],
        };
        strippedMempool.set(entry.uid, stripped);
      }
    });

    // (re)initialize tx selection worker thread
    if (!this.txSelectionWorker) {
      this.txSelectionWorker = new Worker(path.resolve(__dirname, './tx-selection-worker.js'));
      // if the thread throws an unexpected error, or exits for any other reason,
      // reset worker state so that it will be re-initialized on the next run
      this.txSelectionWorker.once('error', () => {
        this.txSelectionWorker = null;
      });
      this.txSelectionWorker.once('exit', () => {
        this.txSelectionWorker = null;
      });
    }

    // run the block construction algorithm in a separate thread, and wait for a result
    let threadErrorListener;
    try {
      const workerResultPromise = new Promise<{ blocks: number[][], rates: Map<number, number>, clusters: Map<number, number[]> }>((resolve, reject) => {
        threadErrorListener = reject;
        this.txSelectionWorker?.once('message', (result): void => {
          resolve(result);
        });
        this.txSelectionWorker?.once('error', reject);
      });
      this.txSelectionWorker.postMessage({ type: 'set', mempool: strippedMempool });
      const { blocks, rates, clusters } = this.convertResultTxids(await workerResultPromise);

      // clean up thread error listener
      this.txSelectionWorker?.removeListener('error', threadErrorListener);

      const processed = this.processBlockTemplates(newMempool, blocks, null, Object.entries(rates), Object.values(clusters), saveResults);

      logger.debug(`makeBlockTemplates completed in ${(Date.now() - start)/1000} seconds`);

      return processed;
    } catch (e) {
      logger.err('makeBlockTemplates failed. ' + (e instanceof Error ? e.message : e));
    }
    return this.mempoolBlocks;
  }

  public async $updateBlockTemplates(newMempool: { [txid: string]: MempoolTransactionExtended }, added: MempoolTransactionExtended[], removed: MempoolTransactionExtended[], saveResults: boolean = false): Promise<void> {
    if (!this.txSelectionWorker) {
      // need to reset the worker
      await this.$makeBlockTemplates(newMempool, saveResults);
      return;
    }

    const start = Date.now();

    for (const tx of Object.values(added)) {
      this.setUid(tx, true);
    }
    const removedUids = removed.map(tx => this.getUid(tx)).filter(uid => (uid !== null && uid !== undefined)) as number[];
    // prepare a stripped down version of the mempool with only the minimum necessary data
    // to reduce the overhead of passing this data to the worker thread
    const addedStripped: CompactThreadTransaction[] = added.filter(entry => (entry.uid !== null && entry.uid !== undefined)).map(entry => {
      return {
        uid: entry.uid || 0,
        fee: entry.fee,
        weight: (entry.adjustedVsize * 4),
        sigops: entry.sigops,
        feePerVsize: entry.adjustedFeePerVsize || entry.feePerVsize,
        effectiveFeePerVsize: entry.effectiveFeePerVsize || entry.adjustedFeePerVsize || entry.feePerVsize,
        inputs: entry.vin.map(v => this.getUid(newMempool[v.txid])).filter(uid => (uid !== null && uid !== undefined)) as number[],
      };
    });

    // run the block construction algorithm in a separate thread, and wait for a result
    let threadErrorListener;
    try {
      const workerResultPromise = new Promise<{ blocks: number[][], rates: Map<number, number>, clusters: Map<number, number[]> }>((resolve, reject) => {
        threadErrorListener = reject;
        this.txSelectionWorker?.once('message', (result): void => {
          resolve(result);
        });
        this.txSelectionWorker?.once('error', reject);
      });
      this.txSelectionWorker.postMessage({ type: 'update', added: addedStripped, removed: removedUids });
      const { blocks, rates, clusters } = this.convertResultTxids(await workerResultPromise);

      this.removeUids(removedUids);

      // clean up thread error listener
      this.txSelectionWorker?.removeListener('error', threadErrorListener);

      this.processBlockTemplates(newMempool, blocks, null, Object.entries(rates), Object.values(clusters), saveResults);
      logger.debug(`updateBlockTemplates completed in ${(Date.now() - start) / 1000} seconds`);
    } catch (e) {
      logger.err('updateBlockTemplates failed. ' + (e instanceof Error ? e.message : e));
    }
  }

  private resetRustGbt(): void {
    this.rustInitialized = false;
    this.rustGbtGenerator = new GbtGenerator();
  }

  private async $rustMakeBlockTemplates(newMempool: { [txid: string]: MempoolTransactionExtended }, saveResults: boolean = false): Promise<MempoolBlockWithTransactions[]> {
    const start = Date.now();

    // reset mempool short ids
    if (saveResults) {
      this.resetUids();
    }
    // set missing short ids
    for (const tx of Object.values(newMempool)) {
      this.setUid(tx, !saveResults);
    }
    // set short ids for transaction inputs
    for (const tx of Object.values(newMempool)) {
      tx.inputs = tx.vin.map(v => this.getUid(newMempool[v.txid])).filter(uid => (uid !== null && uid !== undefined)) as number[];
    }

    // run the block construction algorithm in a separate thread, and wait for a result
    const rustGbt = saveResults ? this.rustGbtGenerator : new GbtGenerator();
    try {
      const { blocks, blockWeights, rates, clusters } = this.convertNapiResultTxids(
        await rustGbt.make(Object.values(newMempool) as RustThreadTransaction[], this.nextUid),
      );
      if (saveResults) {
        this.rustInitialized = true;
      }
      const processed = this.processBlockTemplates(newMempool, blocks, blockWeights, rates, clusters, saveResults);
      logger.debug(`RUST makeBlockTemplates completed in ${(Date.now() - start)/1000} seconds`);
      return processed;
    } catch (e) {
      logger.err('RUST makeBlockTemplates failed. ' + (e instanceof Error ? e.message : e));
      if (saveResults) {
        this.resetRustGbt();
      }
    }
    return this.mempoolBlocks;
  }

  public async $oneOffRustBlockTemplates(newMempool: { [txid: string]: MempoolTransactionExtended }): Promise<MempoolBlockWithTransactions[]> {
    return this.$rustMakeBlockTemplates(newMempool, false);
  }

  public async $rustUpdateBlockTemplates(newMempool: { [txid: string]: MempoolTransactionExtended }, mempoolSize: number, added: MempoolTransactionExtended[], removed: MempoolTransactionExtended[]): Promise<void> {
    // GBT optimization requires that uids never get too sparse
    // as a sanity check, we should also explicitly prevent uint32 uid overflow
    if (this.nextUid + added.length >= Math.min(Math.max(262144, 2 * mempoolSize), MAX_UINT32)) {
      this.resetRustGbt();
    }
    if (!this.rustInitialized) {
      // need to reset the worker
      await this.$rustMakeBlockTemplates(newMempool, true);
      return;
    }

    const start = Date.now();
    // set missing short ids
    for (const tx of added) {
      this.setUid(tx, true);
    }
    // set short ids for transaction inputs
    for (const tx of added) {
      tx.inputs = tx.vin.map(v => this.getUid(newMempool[v.txid])).filter(uid => (uid !== null && uid !== undefined)) as number[];
    }
    const removedUids = removed.map(tx => this.getUid(tx)).filter(uid => (uid !== null && uid !== undefined)) as number[];

    // run the block construction algorithm in a separate thread, and wait for a result
    try {
      const { blocks, blockWeights, rates, clusters } = this.convertNapiResultTxids(
        await this.rustGbtGenerator.update(
          added as RustThreadTransaction[],
          removedUids,
          this.nextUid,
        ),
      );
      const resultMempoolSize = blocks.reduce((total, block) => total + block.length, 0);
      if (mempoolSize !== resultMempoolSize) {
        throw new Error('GBT returned wrong number of transactions, cache is probably out of sync');
      } else {
        this.processBlockTemplates(newMempool, blocks, blockWeights, rates, clusters, true);
      }
      this.removeUids(removedUids);
      logger.debug(`RUST updateBlockTemplates completed in ${(Date.now() - start)/1000} seconds`);
    } catch (e) {
      logger.err('RUST updateBlockTemplates failed. ' + (e instanceof Error ? e.message : e));
      this.resetRustGbt();
    }
  }

  private processBlockTemplates(mempool: { [txid: string]: MempoolTransactionExtended }, blocks: string[][], blockWeights: number[] | null, rates: [string, number][], clusters: string[][], saveResults): MempoolBlockWithTransactions[] {
    for (const [txid, rate] of rates) {
      if (txid in mempool) {
        mempool[txid].effectiveFeePerVsize = rate;
        mempool[txid].cpfpChecked = false;
      }
    }

    const lastBlockIndex = blocks.length - 1;
    let hasBlockStack = blocks.length >= 8;
    let stackWeight;
    let feeStatsCalculator: OnlineFeeStatsCalculator | void;
    if (hasBlockStack) {
      if (blockWeights && blockWeights[7] !== null) {
        stackWeight = blockWeights[7];
      } else {
        stackWeight = blocks[lastBlockIndex].reduce((total, tx) => total + (mempool[tx]?.weight || 0), 0);
      }
      hasBlockStack = stackWeight > config.MEMPOOL.BLOCK_WEIGHT_UNITS;
      feeStatsCalculator = new OnlineFeeStatsCalculator(stackWeight, 0.5, [10, 20, 30, 40, 50, 60, 70, 80, 90]);
    }

    for (const cluster of clusters) {
      for (const memberTxid of cluster) {
        const mempoolTx = mempool[memberTxid];
        if (mempoolTx) {
          const ancestors: Ancestor[] = [];
          const descendants: Ancestor[] = [];
          let matched = false;
          cluster.forEach(txid => {
            if (txid === memberTxid) {
              matched = true;
            } else {
              const relative = {
                txid: txid,
                fee: mempool[txid].fee,
                weight: (mempool[txid].adjustedVsize * 4),
              };
              if (matched) {
                descendants.push(relative);
                mempoolTx.lastBoosted = Math.max(mempoolTx.lastBoosted || 0, mempool[txid].firstSeen || 0);
              } else {
                ancestors.push(relative);
              }
            }
          });
          Object.assign(mempoolTx, {ancestors, descendants, bestDescendant: null, cpfpChecked: true});
        }
      }
    }

    const sizeLimit = (config.MEMPOOL.BLOCK_WEIGHT_UNITS / 4) * 1.2;
    // update this thread's mempool with the results
    let mempoolTx: MempoolTransactionExtended;
    const mempoolBlocks: MempoolBlockWithTransactions[] = blocks.map((block, blockIndex) => {
      let totalSize = 0;
      let totalVsize = 0;
      let totalWeight = 0;
      let totalFees = 0;
      const transactions: MempoolTransactionExtended[] = [];
      for (const txid of block) {
        if (txid) {
          mempoolTx = mempool[txid];
          // save position in projected blocks
          mempoolTx.position = {
            block: blockIndex,
            vsize: totalVsize + (mempoolTx.vsize / 2),
          };
          if (!mempoolTx.cpfpChecked) {
            if (mempoolTx.ancestors?.length) {
              mempoolTx.ancestors = [];
            }
            if (mempoolTx.descendants?.length) {
              mempoolTx.descendants = [];
            }
            mempoolTx.bestDescendant = null;
            mempoolTx.cpfpChecked = true;
          }

          // online calculation of stack-of-blocks fee stats
          if (hasBlockStack && blockIndex === lastBlockIndex && feeStatsCalculator) {
            feeStatsCalculator.processNext(mempoolTx);
          }

          totalSize += mempoolTx.size;
          totalVsize += mempoolTx.vsize;
          totalWeight += mempoolTx.weight;
          totalFees += mempoolTx.fee;

          if (totalVsize <= sizeLimit) {
            transactions.push(mempoolTx);
          }
        }
      }
      return this.dataToMempoolBlocks(
        block,
        transactions,
        totalSize,
        totalWeight,
        totalFees,
        (hasBlockStack && blockIndex === lastBlockIndex && feeStatsCalculator) ? feeStatsCalculator.getRawFeeStats() : undefined,
      );
    });

    if (saveResults) {
      const deltas = this.calculateMempoolDeltas(this.mempoolBlocks, mempoolBlocks);
      this.mempoolBlocks = mempoolBlocks;
      this.mempoolBlockDeltas = deltas;
    }

    return mempoolBlocks;
  }

  private dataToMempoolBlocks(transactionIds: string[], transactions: MempoolTransactionExtended[], totalSize: number, totalWeight: number, totalFees: number, feeStats?: EffectiveFeeStats ): MempoolBlockWithTransactions {
    if (!feeStats) {
      feeStats = Common.calcEffectiveFeeStatistics(transactions);
    }
    return {
      blockSize: totalSize,
      blockVSize: (totalWeight / 4), // fractional vsize to avoid rounding errors
      nTx: transactionIds.length,
      totalFees: totalFees,
      medianFee: feeStats.medianFee, // Common.percentile(transactions.map((tx) => tx.effectiveFeePerVsize), config.MEMPOOL.RECOMMENDED_FEE_PERCENTILE),
      feeRange: feeStats.feeRange, //Common.getFeesInRange(transactions, rangeLength),
      transactionIds: transactionIds,
      transactions: transactions.map((tx) => Common.stripTransaction(tx)),
    };
  }

  private resetUids(): void {
    this.uidMap.clear();
    this.nextUid = 1;
  }

  private setUid(tx: MempoolTransactionExtended, skipSet = false): number {
    if (tx.uid === null || tx.uid === undefined || !skipSet) {
      const uid = this.nextUid;
      this.nextUid++;
      this.uidMap.set(uid, tx.txid);
      tx.uid = uid;
      return uid;
    } else {
      return tx.uid;
    }
  }

  private getUid(tx: MempoolTransactionExtended): number | void {
    if (tx?.uid !== null && tx?.uid !== undefined && this.uidMap.has(tx.uid)) {
      return tx.uid;
    }
  }

  private removeUids(uids: number[]): void {
    for (const uid of uids) {
      this.uidMap.delete(uid);
    }
  }

  private convertResultTxids({ blocks, rates, clusters }: { blocks: number[][], rates: Map<number, number>, clusters: Map<number, number[]>})
    : { blocks: string[][], rates: { [root: string]: number }, clusters: { [root: string]: string[] }} {
    const convertedBlocks: string[][] = blocks.map(block => block.map(uid => {
      return this.uidMap.get(uid) || '';
    }));
    const convertedRates = {};
    for (const rateUid of rates.keys()) {
      const rateTxid = this.uidMap.get(rateUid);
      if (rateTxid) {
        convertedRates[rateTxid] = rates.get(rateUid);
      }
    }
    const convertedClusters = {};
    for (const rootUid of clusters.keys()) {
      const rootTxid = this.uidMap.get(rootUid);
      if (rootTxid) {
        const members = clusters.get(rootUid)?.map(uid => {
          return this.uidMap.get(uid);
        });
        convertedClusters[rootTxid] = members;
      }
    }
    return { blocks: convertedBlocks, rates: convertedRates, clusters: convertedClusters } as { blocks: string[][], rates: { [root: string]: number }, clusters: { [root: string]: string[] }};
  }

  private convertNapiResultTxids({ blocks, blockWeights, rates, clusters }: GbtResult)
    : { blocks: string[][], blockWeights: number[], rates: [string, number][], clusters: string[][] } {
    const convertedBlocks: string[][] = blocks.map(block => block.map(uid => {
      const txid = this.uidMap.get(uid);
      if (txid !== undefined) {
        return txid;
      } else {
        throw new Error('GBT returned a block containing a transaction with unknown uid');
      }
    }));
    const convertedRates: [string, number][] = [];
    for (const [rateUid, rate] of rates) {
      const rateTxid = this.uidMap.get(rateUid) as string;
      convertedRates.push([rateTxid, rate]);
    }
    const convertedClusters: string[][] = [];
    for (const cluster of clusters) {
      convertedClusters.push(cluster.map(uid => this.uidMap.get(uid)) as string[]);
    }
    return { blocks: convertedBlocks, blockWeights, rates: convertedRates, clusters: convertedClusters };
  }
}

export default new MempoolBlocks();
