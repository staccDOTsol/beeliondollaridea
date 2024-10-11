import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TransferHook } from "../target/types/transfer_hook";
import {  EcosystemTransferHook } from "../target/types/ecosystem_transfer_hook";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  Keypair,
  ComputeBudgetProgram,
  SYSVAR_RENT_PUBKEY,
  VersionedTransaction,
  Message,
  MessageV0,
  TransactionMessage,
  Commitment,
} from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  getMintLen,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  createApproveInstruction,
  createSyncNativeInstruction,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAccount,
  createTransferCheckedWithTransferHookInstruction,
  getMint,
  getTransferHook,
  getExtraAccountMetas,
  createInitializeAccount3Instruction,
  createInitializeInstruction,
  resolveExtraAccountMeta,
  createExecuteInstruction,
} from "@solana/spl-token";
import assert from "assert";
import { BN } from "bn.js";
import { AddressUtil, Instruction, Percentage, TransactionBuilder } from "@orca-so/common-sdk";
import Decimal from "decimal.js";
import { base64 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { NO_TOKEN_EXTENSION_CONTEXT, SPLASH_POOL_TICK_SPACING, TokenExtensionContextForPool } from "../whirlpools/legacy-sdk/whirlpool/src";
import { initTickArrayIx } from "../whirlpools/legacy-sdk/whirlpool/dist/instructions";
import { AccountMeta, Connection, TransactionInstruction } from "@solana/web3.js";

export function getExtraAccountMetaAddress(mint: PublicKey, programId: PublicKey): PublicKey {
  const seeds = [Buffer.from('extra-account-metas'), mint.toBuffer()];
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function deEscalateAccountMeta(accountMeta: AccountMeta, accountMetas: AccountMeta[]): AccountMeta {
  const maybeHighestPrivileges = accountMetas
      .filter((x) => x.pubkey.equals(accountMeta.pubkey))
      .reduce<{ isSigner: boolean; isWritable: boolean } | undefined>((acc, x) => {
          if (!acc) return { isSigner: x.isSigner, isWritable: x.isWritable };
          return { isSigner: acc.isSigner || x.isSigner, isWritable: acc.isWritable || x.isWritable };
      }, undefined);
  if (maybeHighestPrivileges) {
      const { isSigner, isWritable } = maybeHighestPrivileges;
      if (!isSigner && isSigner !== accountMeta.isSigner) {
          accountMeta.isSigner = false;
      }
      if (!isWritable && isWritable !== accountMeta.isWritable) {
          accountMeta.isWritable = false;
      }
  }
  return accountMeta;
}
async function addExtraAccountMetasForExecute(
  connection: Connection,
  instruction: TransactionInstruction,
  programId: PublicKey,
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: number | bigint,
  commitment?: Commitment
) {
  const validateStatePubkey = getExtraAccountMetaAddress(mint, programId);
  const validateStateAccount = await connection.getAccountInfo(validateStatePubkey, commitment);
  if (validateStateAccount == null) {
    console.log('123')
      return instruction;
  }
  const validateStateData = getExtraAccountMetas(validateStateAccount);

  // Check to make sure the provided keys are in the instruction
  if (![source, mint, destination, owner].every((key) => instruction.keys.some((meta) => meta.pubkey.equals(key)))) {
      console.log('Missing required account in instruction');
  }

  const executeInstruction = createExecuteInstruction(
      programId,
      source,
      mint,
      destination,
      owner,
      validateStatePubkey,
      BigInt(amount)
  );

  for (const extraAccountMeta of validateStateData) {
      executeInstruction.keys.push(
          deEscalateAccountMeta(
              await resolveExtraAccountMeta(
                  connection,
                  extraAccountMeta,
                  executeInstruction.keys,
                  executeInstruction.data,
                  executeInstruction.programId
              ),
              executeInstruction.keys
          )
      );
  }

  // Add only the extra accounts resolved from the validation state
  instruction.keys.push(...executeInstruction.keys.slice(5));

  // Add the transfer hook program ID and the validation state account
  instruction.keys.push({ pubkey: programId, isSigner: false, isWritable: false });
  instruction.keys.push({ pubkey: validateStatePubkey, isSigner: false, isWritable: false });
}

/*


describe("transfer-hook", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.TransferHook as Program<TransferHook>;
  const wallet = provider.wallet as anchor.Wallet;
  const connection = provider.connection;

  // Generate keypair to use as address for the transfer-hook enabled mint
  let mintKp = Keypair.generate();
  let otherMintKp = Keypair.generate();
  let mint = mintKp.publicKey;
  let otherMint = otherMintKp.publicKey;
  const decimals = 9;
  // Sender token account address

let randomToken;
let randomWhirlpoolPair;
  // Create the two WSol token accounts as part of setup
let ctx:WhirlpoolContext
let pool : Whirlpool
let fetcher : WhirlpoolAccountFetcher
let gameData: any
  before(async () => {
    const extensions = [ExtensionType.TransferHook];
    const mintLen = getMintLen(extensions);
    const lamports =
      await provider.connection.getMinimumBalanceForRentExemption(mintLen);

    // @ts-ignore
    fetcher =  buildDefaultAccountFetcher(connection);
    // @ts-ignore
    ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID, fetcher);
    // Create two mints
    // Select a random token from the top tokens list
    const topTokens = await (await fetch('https://cache.jup.ag/top-tokens')).json() as any;
    randomToken = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"//topTokens[Math.floor(Math.random() * topTokens.length)];
    console.log("Random token selected:", randomToken);
    // Prepare for swap using Jupiter API
    const jupiterQuoteApi = 'https://quote-api.jup.ag/v6/quote';
    const inputMint = NATIVE_MINT.toBase58();
    const outputMint = randomToken;
    const amount = 13000000; // 0.1 SOL in lamports

    // Fetch the swap quote
    const quoteResponse = await fetch(`${jupiterQuoteApi}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50`);
    const quoteData = await quoteResponse.json() as any
    console.log(quoteData)

    // Prepare the swap transaction
    const swapApi = 'https://quote-api.jup.ag/v6/swap';
    const swapRequestBody = {
      quoteResponse: quoteData,
      wrapUnwrapSol: false,
      userPublicKey: wallet.publicKey.toBase58(),
    };

    const swapResponse = await fetch(swapApi, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(swapRequestBody)
    });

    const swapData = await swapResponse.json() as any;

    if (!swapData.swapTransaction) {
      console.error("Failed to get swap transaction from Jupiter");
      return;
    }

    // Deserialize and sign the transaction
    const swapTx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
    swapTx.sign([wallet.payer]);

    // Send the swap transaction
   // const swapTxId = await connection.sendTransaction(swapTx);
   // console.log(`Swap transaction sent: ${swapTxId}`);

    // Wait for confirmation
//    const confirmation = await connection.confirmTransaction(swapTxId, 'finalized');
   // if (confirmation.value.err) {
    //  console.error(`Swap transaction failed: ${confirmation.value.err}`);
   // } else {
   //   console.log(`Swapped 0.1 SOL for ${randomToken}`);
   // }

    // Select the pair of NATIVE_MINT vs something in top tokens from Orca whirlpool with highest TVL
    const whirlpools = await (await fetch('https://api.mainnet.orca.so/v1/whirlpool/list')).json() as any;
    const nativePairs = whirlpools.whirlpools.filter(pool => 
      (pool.tokenA.mint === NATIVE_MINT.toBase58() && pool.tokenB.mint === randomToken) || (pool.tokenB.mint === NATIVE_MINT.toBase58() && pool.tokenA.mint === randomToken)
    ).sort((a, b) => b.tvl - a.tvl);
    randomWhirlpoolPair = nativePairs[0];
    console.log("Highest TVL Orca whirlpool pair:", randomWhirlpoolPair);
    const client = buildWhirlpoolClient(ctx);

     pool = await client.getPool(new PublicKey(randomWhirlpoolPair.address));

    
     let [gameAccount] = PublicKey.findProgramAddressSync([ pool.getAddress().toBuffer()], program.programId);
     
     gameData = await program.account.game.fetch(gameAccount);
     mint = gameData.mint 
     otherMint = gameData.otherMint
     try {     let [gameAccount] = PublicKey.findProgramAddressSync([ pool.getAddress().toBuffer()], program.programId);

      gameData = await program.account.game.fetch(gameAccount);
mint = gameData.mint 
otherMint = gameData.otherMint
    const whirlpools = await (await fetch('https://api.mainnet.orca.so/v1/whirlpool/list')).json() as any;
    const nativePairs = whirlpools.whirlpools.filter(pool => 
      (pool.tokenA.mint === NATIVE_MINT.toBase58() && pool.tokenB.mint === randomToken) || (pool.tokenB.mint === NATIVE_MINT.toBase58() && pool.tokenA.mint === randomToken)
    ).sort((a, b) => b.tvl - a.tvl);
    randomWhirlpoolPair = nativePairs[0];
    console.log("Highest TVL Orca whirlpool pair:", randomWhirlpoolPair);
    const client = buildWhirlpoolClient(ctx);

     pool = await client.getPool(new PublicKey(randomWhirlpoolPair.address));
     const [positionAuthority] = PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), mint.toBuffer()], program.programId);
const mintA = pool.getTokenAInfo().mint
const mintB = pool.getTokenBInfo().mint
    // Get account infos for all token accounts
    const accountInfos = await Promise.all([
      connection.getAccountInfo(getAssociatedTokenAddressSync(mintA, wallet.publicKey, true)),
      connection.getAccountInfo(getAssociatedTokenAddressSync(mintB, wallet.publicKey, true)),
      connection.getAccountInfo(getAssociatedTokenAddressSync(mintA, positionAuthority, true)),
      connection.getAccountInfo(getAssociatedTokenAddressSync(mintB, positionAuthority, true)),
      connection.getAccountInfo(getAssociatedTokenAddressSync(gameData.mint, wallet.publicKey, true, TOKEN_2022_PROGRAM_ID)),
      connection.getAccountInfo(getAssociatedTokenAddressSync(gameData.otherMint, wallet.publicKey, true, TOKEN_2022_PROGRAM_ID))
    ]);

    // Create instructions for accounts that don't exist
    const createAtaInstructions = accountInfos.map((info, index) => {
      if (info === null) {
        const m = index === 0 || index === 2 ? pool.getTokenAInfo().mint :
                  index === 1 || index === 3 ? pool.getTokenBInfo().mint :
                  index === 4 ? gameData.mint : gameData.otherMint;
        
        if (!m) return null;

        let owner = index < 2  || index > 3 ? wallet.publicKey : positionAuthority;

        const programId = index < 4 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
        return createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          getAssociatedTokenAddressSync(m, owner, true, programId),
          owner,
          m,
          programId
        );
      }
      return null;
    }).filter(instruction => instruction !== null);

    // If there are any instructions to create accounts, send the transaction
    if (createAtaInstructions.length > 0) {
      const transaction = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitPrice({microLamports: 333333}),
        ComputeBudgetProgram.setComputeUnitLimit({units: 1_400_000}),
        ...createAtaInstructions
      );
      const signature = await sendAndConfirmTransaction(connection, transaction, [wallet.payer]);
      console.log(`Created ${createAtaInstructions.length} associated token accounts. Signature: ${signature}`);
    }
  } catch (err){

    const whirlpools = await (await fetch('https://api.mainnet.orca.so/v1/whirlpool/list')).json() as any;
    const nativePairs = whirlpools.whirlpools.filter(pool => 
      (pool.tokenA.mint === NATIVE_MINT.toBase58() && pool.tokenB.mint === randomToken) || (pool.tokenB.mint === NATIVE_MINT.toBase58() && pool.tokenA.mint === randomToken)
    ).sort((a, b) => b.tvl - a.tvl);
    randomWhirlpoolPair = nativePairs[0];
    console.log("Highest TVL Orca whirlpool pair:", randomWhirlpoolPair);
    const client = buildWhirlpoolClient(ctx);

    mint = gameData.mint 
    otherMint = gameData.otherMint
     pool = await client.getPool(new PublicKey(randomWhirlpoolPair.address));
    const [positionAuthority] = PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), mint.toBuffer()], program.programId);
    const mintA = pool.getTokenAInfo().mint;
    const mintB = pool.getTokenBInfo().mint;
    console.log("mintA", mintA.toBase58());
    console.log("mintB", mintB.toBase58());

    const accountInfos = await Promise.all([
      connection.getAccountInfo(getAssociatedTokenAddressSync(mintA, wallet.publicKey, true)),
      connection.getAccountInfo(getAssociatedTokenAddressSync(mintB, wallet.publicKey, true)),
      connection.getAccountInfo(getAssociatedTokenAddressSync(mintA, positionAuthority, true)),
      connection.getAccountInfo(getAssociatedTokenAddressSync(mintB, positionAuthority, true))
    ]);

    // Create instructions for accounts that don't exist
    const createAtaInstructions = accountInfos.map((info, index) => {
      if (info === null) {
        const m = index === 0 || index === 2 ? pool.getTokenAInfo().mint :
                   pool.getTokenBInfo().mint ;
        
        if (!m) return null;

        let owner = index < 2  || index > 3 ? wallet.publicKey : positionAuthority;

        const programId = index < 4 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
        return createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          getAssociatedTokenAddressSync(m, owner, true, programId),
          owner,
          m,
          programId
        );
      }
      return null;
    }).filter(instruction => instruction !== null);

    // If there are any instructions to create accounts, send the transaction
    if (createAtaInstructions.length > 0) {
      const transaction = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitPrice({microLamports: 333333}),
        ComputeBudgetProgram.setComputeUnitLimit({units: 1_400_000}),
        ...createAtaInstructions
      );
      const signature = await sendAndConfirmTransaction(connection, transaction, [wallet.payer]);
      console.log(`Created ${createAtaInstructions.length} associated token accounts. Signature: ${signature}`);
    }
  }
  });

  // Account to store extra accounts required by the transfer hook instruction
  it("Create ExtraAccountMetaList Account", async () => {

    const whirlpools = await (await fetch('https://api.mainnet.orca.so/v1/whirlpool/list')).json() as any;
    const nativePairs = whirlpools.whirlpools.filter(pool => 
      (pool.tokenA.mint === NATIVE_MINT.toBase58() && pool.tokenB.mint === randomToken) || (pool.tokenB.mint === NATIVE_MINT.toBase58() && pool.tokenA.mint === randomToken)
    ).sort((a, b) => b.tvl - a.tvl);
    randomWhirlpoolPair = nativePairs[0];
    console.log("Highest TVL Orca whirlpool pair:", randomWhirlpoolPair);
    const client = buildWhirlpoolClient(ctx);

    mint = gameData.mint 
    otherMint = gameData.otherMint
     pool = await client.getPool(new PublicKey(randomWhirlpoolPair.address));
    const [positionAuthority] = PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), gameData? gameData.mint.toBuffer() : mint.toBuffer() ], program.programId);

    const positionMintKeypair = Keypair.generate();
    const positionPda = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, positionMintKeypair.publicKey);
    const positionTokenAccountAddress = await getAssociatedTokenAddressSync(
      positionMintKeypair.publicKey,
      positionAuthority,
      true,
    );
    const mintA = pool.getTokenAInfo().mint 
    const mintB = pool.getTokenBInfo().mint 
    const currentTickIndex = pool.getData().tickCurrentIndex;

    const currentPrice = PriceMath.tickIndexToPrice(currentTickIndex, pool.getTokenAInfo().decimals, pool.getTokenBInfo().decimals);
    const priceLower = currentPrice.mul(new Decimal(0.98)); // 1% lower
    const priceUpper = currentPrice.mul(new Decimal(1.02)); // 1% higher
    // Convert prices to tick indices
    const tickLowerIndex = PriceMath.priceToInitializableTickIndex(priceLower, pool.getTokenAInfo().decimals, pool.getTokenBInfo().decimals, pool.getData().tickSpacing);
    const tickUpperIndex = PriceMath.priceToInitializableTickIndex(priceUpper, pool.getTokenAInfo().decimals, pool.getTokenBInfo().decimals, pool.getData().tickSpacing);

    // Ensure the tick indices are initialized
    const tickArrayLower = PDAUtil.getTickArray(ORCA_WHIRLPOOL_PROGRAM_ID, pool.getAddress(), TickUtil.getStartTickIndex(tickLowerIndex, pool.getData().tickSpacing));
    const tickArrayUpper = PDAUtil.getTickArray(ORCA_WHIRLPOOL_PROGRAM_ID, pool.getAddress(), TickUtil.getStartTickIndex(tickUpperIndex, pool.getData().tickSpacing));

    console.log("Lower Tick Index:", tickLowerIndex);
    console.log("Upper Tick Index:", tickUpperIndex);

    const connection = new Connection("https://rpc.ironforge.network/mainnet?apiKey=01HRZ9G6Z2A19FY8PR4RF4J4PW");
    const wallet = new anchor.Wallet(Keypair.fromSecretKey(new Uint8Array(JSON.parse(require('fs').readFileSync('/Users/jarettdunn/99.json').toString()))))
    const provider = new AnchorProvider(connection, wallet, {});
      var aiAccountA = await connection.getAccountInfo(gameData.mint)
      var aiAccountB = await connection.getAccountInfo(new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"))
      
      // Get token account balances
      var tokenAccountA = await getAssociatedTokenAddressSync(gameData.mint, wallet.publicKey, true, aiAccountA.owner);
      var tokenAccountB = await getAssociatedTokenAddressSync(new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), wallet.publicKey, true, aiAccountB.owner);
  
      var tokenBalanceA = await connection.getTokenAccountBalance(tokenAccountA);
      var tokenBalanceB = await connection.getTokenAccountBalance(tokenAccountB);
  
      var uiAmountA = tokenBalanceA.value.amount;
      var uiAmountB = tokenBalanceB.value.amount;
  
      console.log(`Token A balance: ${uiAmountA}`);
      console.log(`Token B balance: ${uiAmountB}`);
    const form = {
      payer: wallet.publicKey.toString(),
      tokenA: mintA.toString(),
      tokenB: mintB.toString(),
      tokenAAmount:uiAmountA,
      tokenBAmount: uiAmountB
    }

    const response = await fetch('https://api.fluxbeam.xyz/v1/token_pools', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        "payer": form.payer,
        "token_a": form.tokenA,
        "token_b": form.tokenB,
        "token_a_amount": form.tokenAAmount,
        "token_b_amount": form.tokenBAmount
      })
    });

    const resp = await response.json() as any

    console.log("Pool Address:", resp.pool);
console.log(resp)
    // Decode the transaction from base64
    const swapTransactionBuf = Buffer.from(resp.transaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
console.log(transaction)
    const extraAccountMetasB = await getExtraAccountMetasForHookProgram(
      provider,
      TEST_TRANSFER_HOOK_PROGRAM_ID,
      tokenAccountB,
      gameData.mint,
      getAssociatedTokenAddressSync(gameData.mint, new PublicKey(resp.pool), true, TOKEN_2022_PROGRAM_ID),
      wallet.publicKey,
      BigInt(uiAmountA)
    );
    // Decode and decompile the transaction
    const [decodedInstructions, addressLookupTables] = await (async () => {
      const message = transaction.message;
      const addressLookupTablesResponses = await Promise.all(
        message.addressTableLookups.map((alt) =>
          connection.getAddressLookupTable(alt.accountKey),
        ),
      );
      const addressLookupTables = addressLookupTablesResponses
        .map((alt) => alt.value)
        .filter((x) => x !== null);

      const decompiledMessage = TransactionMessage.decompile(message, {
        addressLookupTableAccounts: addressLookupTables,
      });

      return [decompiledMessage.instructions, addressLookupTables];
    })();

    // Add extra account metas to the appropriate instruction
    const modifiedInstructions = decodedInstructions.map((instruction) => {
      if (instruction.programId.equals(TOKEN_2022_PROGRAM_ID)) {
        return {
          ...instruction,
          keys: [...instruction.keys, ...(extraAccountMetasB || [])],
        };
      }
      return instruction;
    });

    // Recompile the transaction with modified instructions
    const recompiledMessage = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: transaction.message.recentBlockhash,
      instructions: modifiedInstructions,
    }).compileToV0Message(addressLookupTables);

    // Create a new transaction with the recompiled message
    const newTransaction = new VersionedTransaction(recompiledMessage);



    // Add all new instructions to the transaction
    console.log("Transaction", newTransaction);
    // Sign the transaction with the payer wallet
    newTransaction.sign([wallet.payer]);
    // Sign the transaction with all original signers
   newTransaction.signatures[1] = transaction.signatures[1]
   newTransaction.signatures[2] = transaction.signatures[2]

    // Execute the transaction
    const sig = await connection.sendRawTransaction(newTransaction.serialize(), {maxRetries: 3, skipPreflight: true});

    console.log("Transaction Signature:", sig);
    /*
    let initializeExtraAccountMetaListInstruction = await program.methods
      .initializeFirstExtraAccountMetaList()
      .accounts({
        payer: wallet.publicKey,
        positionTokenAccount: positionTokenAccountAddress,
        mint: mint,
        position: positionPda.publicKey,
        otherMint: otherMint,
        mintA: mintA,
        tickArrayLower: tickArrayLower.publicKey,
        tickArrayUpper: tickArrayUpper.publicKey,
        whirlpool: pool.getAddress(),
        tokenOwnerAccountA: getAssociatedTokenAddressSync(mintA, positionAuthority, true),
        tokenVaultA: pool.getTokenVaultAInfo().address,
        tokenOwnerAccountB: getAssociatedTokenAddressSync(mintB, positionAuthority, true),
        tokenVaultB: pool.getTokenVaultBInfo().address,
      })
      .instruction();
    let transaction = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({microLamports: 333333}),
      ComputeBudgetProgram.setComputeUnitLimit({units: 1_400_000}),
      initializeExtraAccountMetaListInstruction,
      await program.methods
      .initializeSecondExtraAccountMetaList()
      .accounts({
        positionTokenAccount: positionTokenAccountAddress,
        payer: wallet.publicKey,
        mint: mint,
        position: positionPda.publicKey,
        mintB: mintB,
        otherMint: otherMint,
        g: tickArrayLower.publicKey,
        tickArrayUpper: tickArrayUpper.publicKey,
        whirlpool: pool.getAddress(),
        tokenOwnerAccountA: getAssociatedTokenAddressSync(mintA, positionAuthority, true),
        tokenVaultA: pool.getTokenVaultAInfo().address,
        tokenOwnerAccountB: getAssociatedTokenAddressSync(mintB, positionAuthority, true),
        tokenVaultB: pool.getTokenVaultBInfo().address,
      })
      .instruction()
    );
    transaction.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
    transaction.feePayer = wallet.publicKey;
    try {
    transaction.sign(wallet.payer, mintKp, otherMintKp);

    let txSig = await connection.sendRawTransaction(transaction.serialize());
    console.log("Transaction Signature:", txSig);
    await connection.confirmTransaction(txSig, "finalized")

    } catch (err){
      console.log(err)
    }
   
  const increase_quote = increaseLiquidityQuoteByInputToken(
    pool.getTokenBInfo().mint,
    new Decimal(await (await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(pool.getTokenBInfo().mint, wallet.publicKey, true))).value.uiAmount / 100),
    tickLowerIndex,
    tickUpperIndex,
    Percentage.fromFraction(1, 100),
    pool,
    await TokenExtensionUtil.buildTokenExtensionContext(ctx.fetcher, pool.getData())
  );
  const minnttt = mint 
  const otherMinttt =  otherMint
console.log(positionPda.bump, tickLowerIndex, tickUpperIndex, increase_quote.liquidityAmount)
try {
const tx = await program.methods.openPosition(
  positionPda.bump,  tickLowerIndex, tickUpperIndex, increase_quote.tokenMaxA, increase_quote.tokenMaxB
).accounts({
  owner: positionAuthority,
  tokenPositionAccountA: getAssociatedTokenAddressSync(mintA, positionAuthority, true),
  tokenPositionAccountB: getAssociatedTokenAddressSync(mintB, positionAuthority, true),
  funder: wallet.publicKey,
  otherMint: otherMinttt,
  userTokenAccountOther: getAssociatedTokenAddressSync(otherMinttt, wallet.publicKey, true, TOKEN_2022_PROGRAM_ID),
  userTokenAccountMint: getAssociatedTokenAddressSync(minnttt, wallet.publicKey, true, TOKEN_2022_PROGRAM_ID),
  mint: minnttt,
  tokenOwnerAccountA: getAssociatedTokenAddressSync(mintA, wallet.publicKey, true),
  tokenOwnerAccountB: getAssociatedTokenAddressSync(mintB, wallet.publicKey, true),
  tokenVaultA: pool.getTokenVaultAInfo().address,
  tokenVaultB: pool.getTokenVaultBInfo().address,
  tickArrayLower: tickArrayLower.publicKey,
  tickArrayUpper: tickArrayUpper.publicKey,
  positionMint: positionMintKeypair.publicKey,
  whirlpool: pool.getAddress(),
  position: positionPda.publicKey,
  positionTokenAccount: positionTokenAccountAddress,
  
  }).
  preInstructions([ComputeBudgetProgram.setComputeUnitPrice({microLamports: 333333})])
  .signers([positionMintKeypair])
  .instruction();
   transaction = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({units: 1_400_000}),
    tx
  );
  transaction.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
  transaction.feePayer = wallet.publicKey;
  transaction.sign(positionMintKeypair, wallet.payer);

  let txSig = await connection.sendRawTransaction(transaction.serialize());
  console.log("created position 0 Transaction Signature:", txSig);
} catch (err){
  console.log(err)
  }
 
  });
  /*

  it("does a dozen proxyOpenPOsition with the transfer hook", async () => {
    const client = buildWhirlpoolClient(ctx);

    const pool = await client.getPool(new PublicKey(randomWhirlpoolPair.address));
    const mintA = pool.getTokenAInfo().mint;
    const mintB = pool.getTokenBInfo().mint;
    const whirlpool_data = pool.getData();
    const tickSpacing = whirlpool_data.tickSpacing;
    let txSig 

    for (let i = 0; i < 12; i++) {for
      const doneLowerTicks: number[] = [];
      const doneUpperTicks: number[] = [];
      console.log("current_tick_index", whirlpool_data.tickCurrentIndex);

      const tickArrays = await SwapUtils.getBatchTickArrays(
        ORCA_WHIRLPOOL_PROGRAM_ID,ctx.fetcher,
        [{tickCurrentIndex: whirlpool_data.tickCurrentIndex, tickSpacing: whirlpool_data.tickSpacing, aToB: true, whirlpoolAddress: pool.getAddress()},
        {tickCurrentIndex: whirlpool_data.tickCurrentIndex, tickSpacing: whirlpool_data.tickSpacing, aToB: false, whirlpoolAddress: pool.getAddress()}
        ],{maxAge: Number.MAX_SAFE_INTEGER}
      );
      console.log("tickArrays", tickArrays);
      
      // Find the closest lower and upper initialized ticks
      let tickLowerIndex = null;
      let tickUpperIndex = null;
      for (let j = 0; j < tickArrays.length; j++) {
        const tickArray = tickArrays[j];
        if (tickArray) {
          for (let k = 0; k < tickArray.length; k++) {
            const tickArrayData = tickArray[k];
            const startTickIndex = tickArrayData.startTickIndex;
            const endTickIndex = startTickIndex + (tickSpacing * 88); // 88 is the number of ticks in a tick array
            
            if (startTickIndex <= whirlpool_data.tickCurrentIndex && whirlpool_data.tickCurrentIndex < endTickIndex) {
              const lowerTick = Math.max(startTickIndex, whirlpool_data.tickCurrentIndex - (4 * tickSpacing));
              const upperTick = Math.min(endTickIndex - 1, whirlpool_data.tickCurrentIndex + (4 * tickSpacing));
              
              console.log("lowerTick", lowerTick);
              console.log("upperTick", upperTick);
              
                tickLowerIndex = lowerTick;
                tickUpperIndex = upperTick;
              
              
              if (tickLowerIndex !== null && tickUpperIndex !== null) {
                break;
              }
            }
          }
        }
        if (tickLowerIndex !== null && tickUpperIndex !== null) {
          break;
        }
      }
      mint = gameData.mint 
      otherMint = gameData.otherMint
      const [positionAuthority] = PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), gameData? gameData.mint.toBuffer() : mint.toBuffer()], program.programId);

      const positionMintKeypair = Keypair.generate();
      const positionPda = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, positionMintKeypair.publicKey);
      const positionTokenAccountAddress = await getAssociatedTokenAddressSync(
        positionMintKeypair.publicKey,
        positionAuthority,
        true,
      );
      const mintA = pool.getTokenAInfo().mint 
      const mintB = pool.getTokenBInfo().mint 
      const currentTickIndex = pool.getData().tickCurrentIndex;
      // Ensure the tick arrays are initialized
      const tickArrayLower = PDAUtil.getTickArray(ORCA_WHIRLPOOL_PROGRAM_ID, pool.getAddress(), TickUtil.getStartTickIndex(tickLowerIndex, pool.getData().tickSpacing));
      const tickArrayUpper = PDAUtil.getTickArray(ORCA_WHIRLPOOL_PROGRAM_ID, pool.getAddress(), TickUtil.getStartTickIndex(tickUpperIndex, pool.getData().tickSpacing));

      // Calculate the current price and price range
      const currentPrice = PriceMath.tickIndexToPrice(currentTickIndex, pool.getTokenAInfo().decimals, pool.getTokenBInfo().decimals);
      const priceLower = currentPrice.mul(new Decimal(0.98)); // 1% lower
      const priceUpper = currentPrice.mul(new Decimal(1.02)); // 1% higher

      // Convert prices to tick indices (for reference, not used in this context)
      const calculatedTickLowerIndex = PriceMath.priceToInitializableTickIndex(priceLower, pool.getTokenAInfo().decimals, pool.getTokenBInfo().decimals, pool.getData().tickSpacing)
      const calculatedTickUpperIndex = PriceMath.priceToInitializableTickIndex(priceUpper, pool.getTokenAInfo().decimals, pool.getTokenBInfo().decimals, pool.getData().tickSpacing)

      console.log("Current Price:", currentPrice.toString());
      console.log("Price Range:", priceLower.toString(), "-", priceUpper.toString());
      console.log("Tick Range:", tickLowerIndex, "-", tickUpperIndex);
      console.log("Calculated Tick Range:", calculatedTickLowerIndex, "-", calculatedTickUpperIndex);
      const increase_quote = increaseLiquidityQuoteByInputToken(
        pool.getTokenBInfo().mint,
        new Decimal(await (await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(pool.getTokenBInfo().mint, wallet.publicKey, true))).value.uiAmount / 100),
        tickLowerIndex,
        tickUpperIndex,
        // @ts-ignore
        Percentage.fromFraction(1, 100),
        pool,
           await  TokenExtensionUtil.buildTokenExtensionContext(ctx.fetcher, pool.getData())

      );
     
      const minnttt = mint 
      const otherMinttt =  otherMint
    console.log(positionPda.bump, tickLowerIndex, tickUpperIndex, increase_quote.liquidityAmount)
    try {
     
    const tx = await program.methods.openPosition(
      positionPda.bump,  tickLowerIndex, tickUpperIndex, increase_quote.tokenMaxA, increase_quote.tokenMaxB
    ).accounts({
      owner: positionAuthority,
      tokenPositionAccountA: getAssociatedTokenAddressSync(mintA, positionAuthority, true),
      tokenPositionAccountB: getAssociatedTokenAddressSync(mintB, positionAuthority, true),
      funder: wallet.publicKey,
      otherMint: otherMinttt,
      userTokenAccountOther: getAssociatedTokenAddressSync(otherMinttt, wallet.publicKey, true, TOKEN_2022_PROGRAM_ID),
      userTokenAccountMint: getAssociatedTokenAddressSync(minnttt, wallet.publicKey, true, TOKEN_2022_PROGRAM_ID),
      mint: minnttt,
      tokenOwnerAccountA: getAssociatedTokenAddressSync(mintA, wallet.publicKey, true),
      tokenOwnerAccountB: getAssociatedTokenAddressSync(mintB, wallet.publicKey, true),
      tokenVaultA: pool.getTokenVaultAInfo().address,
      tokenVaultB: pool.getTokenVaultBInfo().address,
      tickArrayLower: tickArrayLower.publicKey,
      tickArrayUpper: tickArrayUpper.publicKey,
      positionMint: positionMintKeypair.publicKey,
      whirlpool: pool.getAddress(),
      position: positionPda.publicKey,
      positionTokenAccount: positionTokenAccountAddress,
      
    }).
    preInstructions([ComputeBudgetProgram.setComputeUnitPrice({microLamports: 333333})])
    .signers([positionMintKeypair])
    .instruction();
    const transaction = new Transaction().add(

      ComputeBudgetProgram.setComputeUnitLimit({units: 1_400_000}),
      tx
    );
    transaction.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
    transaction.feePayer = wallet.publicKey;
    transaction.sign(positionMintKeypair, wallet.payer);
     txSig = await connection.sendRawTransaction(transaction.serialize());
    console.log("created position", i, "Transaction Signature:", txSig);

  } catch (e) {
    console.log("Error creating position", i, e);
  }

  }
  await connection.confirmTransaction(txSig, "finalized")

  })
  it("Transfer Hook with Extra Account Meta", async () => {
    // 1 tokens
    const amount = 1;
    let [gameAccount] = PublicKey.findProgramAddressSync([ pool.getAddress().toBuffer()], program.programId);
    
    gameData = await program.account.game.fetch(gameAccount);
    mint = gameData.mint 
otherMint = gameData.otherMint
    const bigIntAmount = BigInt(amount);

    for (let i = 0; i < 3; i++) {
      await new Promise(resolve => setTimeout(resolve, Math.random() * 10000+1000));
    
      // Standard token transfer instruction
      const receipient = Keypair.generate().publicKey;
    
      // Check if the token accounts exist before creating transfer instructions
      const sourceAccount = getAssociatedTokenAddressSync(gameData.mint, wallet.publicKey, true, TOKEN_2022_PROGRAM_ID);
      const destinationAccount = getAssociatedTokenAddressSync(gameData.mint, receipient, true, TOKEN_2022_PROGRAM_ID);

      let transaction = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitPrice({microLamports: 333333}),
        ComputeBudgetProgram.setComputeUnitLimit({units: 1_400_000})
      );

      // Check if destination account exists, if not, create it
      if (!(await connection.getAccountInfo(destinationAccount))) {
        transaction.add(
          createAssociatedTokenAccountInstruction(
            wallet.publicKey, 
            destinationAccount, 
            receipient, 
            gameData.mint, 
            TOKEN_2022_PROGRAM_ID
          )
        );
      }

      // Create transfer instruction only if source account exists
      if (await connection.getAccountInfo(sourceAccount)) {
        const transferInstruction = await createTransferCheckedWithTransferHookInstruction(
          connection,
          sourceAccount,
          gameData.mint,
          destinationAccount,
          wallet.publicKey,
          bigIntAmount,
          pool.getTokenAInfo().decimals,
          [],
          "confirmed",
          TOKEN_2022_PROGRAM_ID
        );
        transaction.add(transferInstruction);
      } else {
        console.log(`Source account ${sourceAccount.toBase58()} does not exist. Skipping transfer.`);
        continue;
      }

      transaction.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
      transaction.feePayer = wallet.publicKey;
      transaction.sign(wallet.payer);
      let txSig = await connection.sendRawTransaction(transaction.serialize());
      console.log("Transfer Signature:", txSig);

      // Repeat the process for the other mint
      const otherSourceAccount = getAssociatedTokenAddressSync(gameData.otherMint, wallet.publicKey, true, TOKEN_2022_PROGRAM_ID);
      const otherDestinationAccount = getAssociatedTokenAddressSync(gameData.otherMint, receipient, true, TOKEN_2022_PROGRAM_ID);

      transaction = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitPrice({microLamports: 333333}),
        ComputeBudgetProgram.setComputeUnitLimit({units: 1_400_000})
      );

      if (!(await connection.getAccountInfo(otherDestinationAccount))) {
        transaction.add(
          createAssociatedTokenAccountInstruction(
            wallet.publicKey, 
            otherDestinationAccount, 
            receipient, 
            gameData.otherMint, 
            TOKEN_2022_PROGRAM_ID
          )
        );
      }

      if (await connection.getAccountInfo(otherSourceAccount)) {
        const transferInstruction = await createTransferCheckedWithTransferHookInstruction(
          connection,
          otherSourceAccount,
          gameData.otherMint,
          otherDestinationAccount,
          wallet.publicKey,
          bigIntAmount,
          pool.getTokenBInfo().decimals,
          [],
          "confirmed",
          TOKEN_2022_PROGRAM_ID
        );
        transaction.add(transferInstruction);
      } else {
        console.log(`Source account ${otherSourceAccount.toBase58()} does not exist. Skipping transfer.`);
        continue;
      }

      transaction.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
      transaction.feePayer = wallet.publicKey;
      transaction.sign(wallet.payer);
      txSig = await connection.sendRawTransaction(transaction.serialize());
      console.log("Transfer Signature:", txSig);
    }

  });
});



})
// @ts-nocheck
const { AnchorProvider, web3 } = require("@coral-xyz/anchor");
const {
  ORCA_WHIRLPOOLS_CONFIG,
  PoolUtil,
  WhirlpoolClient,
} = require("../whirlpools/legacy-sdk/whirlpool/src")
const {
  TokenUtil,
  AddressUtil,
  TransactionBuilder,
} = require("@orca-so/common-sdk");

async function createTokenAccountInstrs(
    provider: anchor.AnchorProvider,
    newAccountPubkey: PublicKey,
    mint: PublicKey,
    owner: PublicKey,
    lamports?: number,
    tokenProgram?: PublicKey
  ) {
    if (lamports === undefined) {
      lamports = await provider.connection.getMinimumBalanceForRentExemption(165);
    }
    return [
      SystemProgram.createAccount({
        fromPubkey: provider.wallet.publicKey,
        newAccountPubkey,
        space: 165,
        lamports,
        programId: tokenProgram || TOKEN_PROGRAM_ID,
      }),
      createInitializeAccount3Instruction(newAccountPubkey, mint, owner),
    ];
  }
const TEST_TRANSFER_HOOK_PROGRAM_ID = new PublicKey("J2Bha9DydTcsRodb5gfeQZo66odNNmKQ5BvSiQWbDHWQ")
const {
  createUpdateTransferHookInstruction,
} = require("@solana/spl-token");
*/
 async function getExtraAccountMetasForHookProgram(
    provider: anchor.AnchorProvider,
    hookProgramId: PublicKey,
    source: PublicKey,
    mint: PublicKey,
    destination: PublicKey,
    owner: PublicKey,
    amount: number | bigint,
  ): Promise<AccountMeta[] | undefined> {
    const instruction = new TransactionInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      keys: [
        { pubkey: source, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: destination, isSigner: false, isWritable: false },
        { pubkey: owner, isSigner: false, isWritable: false },
        { pubkey: owner, isSigner: false, isWritable: false },
      ],
    });
  
    await addExtraAccountMetasForExecute(
      provider.connection,
      instruction,
      hookProgramId,
      source,
      mint,
      destination,
      owner,
      amount,
      "confirmed",
    );
  
    const extraAccountMetas = instruction.keys.slice(5);
    return extraAccountMetas.length > 0 ? extraAccountMetas : undefined;
  }
 async function getExtraAccountMetasForTestTransferHookProgram(
  provider: anchor.AnchorProvider,
  mint: PublicKey,
  source: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  programId: PublicKey
): Promise<AccountMeta[] | undefined> {
  return getExtraAccountMetasForHookProgram(
    provider,
    programId,
    source,
    mint,
    destination,
    owner,
    0, // not used to derive addresses
  );
}
/*
 async function getTestTransferHookCounter(
  provider: anchor.AnchorProvider,
  mint: PublicKey,
): Promise<number> {
  const [counterAccountPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("counter"), mint.toBuffer()],
    TEST_TRANSFER_HOOK_PROGRAM_ID,
  );

  const data = await provider.connection.getAccountInfo(counterAccountPDA);
  return data!.data.readInt32LE(8);
}

 async function updateTransferHookProgram(
  provider: anchor.AnchorProvider,
  mint: PublicKey,
  newTransferHookProgramId: PublicKey,
  authority?: Keypair,
) {
  const tx = new Transaction();
  tx.add(
    createUpdateTransferHookInstruction(
      mint,
      authority?.publicKey ?? provider.wallet.publicKey,
      newTransferHookProgramId,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  return provider.sendAndConfirm(tx, !!authority ? [authority] : [], {
    commitment: "confirmed",
  });
}

 function createInitializeExtraAccountMetaListInstruction(
  payer: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  // create ExtraAccountMetaList account
  const [extraAccountMetaListPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()],
    TEST_TRANSFER_HOOK_PROGRAM_ID,
  );
  const [counterAccountPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("counter"), mint.toBuffer()],
    TEST_TRANSFER_HOOK_PROGRAM_ID,
  );

  return {
    programId: TEST_TRANSFER_HOOK_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: extraAccountMetaListPDA, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: counterAccountPDA, isSigner: false, isWritable: true },
      {
        pubkey: TOKEN_2022_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
    ],
    data: Buffer.from([0x5c, 0xc5, 0xae, 0xc5, 0x29, 0x7c, 0x13, 0x03]), // InitializeExtraAccountMetaList
  };
}*/

async function initSplashPoolWithTransferHook(mintb: PublicKey, minta: PublicKey, badge: PublicKey, config: PublicKey) {
  const connection = new Connection("https://rpc.ironforge.network/mainnet?apiKey=01HRZ9G6Z2A19FY8PR4RF4J4PW");
  const wallet = new anchor.Wallet(Keypair.fromSecretKey(new Uint8Array(JSON.parse(require('fs').readFileSync('/Users/jarettdunn/99.json').toString()))))
  const provider = new anchor.AnchorProvider(connection, wallet, {});
    var aiAccountA = await connection.getAccountInfo(minta)
    var aiAccountB = await connection.getAccountInfo(mintb)
    
    // Get token account balances
    var tokenAccountA = await getAssociatedTokenAddressSync(minta, wallet.publicKey, true, aiAccountA.owner);
    var tokenAccountB = await getAssociatedTokenAddressSync(mintb, wallet.publicKey, true, aiAccountB.owner);

    var tokenBalanceA = await connection.getTokenAccountBalance(tokenAccountA);
    var tokenBalanceB = await connection.getTokenAccountBalance(tokenAccountB);

    var uiAmountA = tokenBalanceA.value.uiAmount/2;
    var uiAmountB = tokenBalanceB.value.uiAmount;

    console.log(`Token A balance: ${uiAmountA}`);
    console.log(`Token B balance: ${uiAmountB}`);

    // Use these uiAmounts for initialTokenAAmount and initialTokenBAmount
    const correctTokenOrder = [minta, mintb].sort((a, b) => 
        a.toBuffer().compare(b.toBuffer())
    ).map((addr) => addr.toString());
      const [mintA, mintB, initialTokenAAmount, initialTokenBAmount] = 
    correctTokenOrder[0] === minta.toString() 
        ? [minta, mintb, (
            350), (444)]
        : [mintb, minta, (444), (350)];
        var aiAccountA = await connection.getAccountInfo(mintA)
        var aiAccountB = await connection.getAccountInfo(mintB)
        var tokenAccountA = await getAssociatedTokenAddressSync(mintA, wallet.publicKey, true, aiAccountA.owner);
        var tokenAccountB = await getAssociatedTokenAddressSync(mintB, wallet.publicKey, true, aiAccountB.owner);
    
        var tokenBalanceA = await connection.getTokenAccountBalance(tokenAccountA);
        var tokenBalanceB = await connection.getTokenAccountBalance(tokenAccountB);
    
    // Check if mintA is USDC (assuming USDC mint address)
    const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    
    var uiAmountA = tokenBalanceA.value.uiAmount;
    var uiAmountB = tokenBalanceB.value.uiAmount;

   uiAmountA = uiAmountA * 0.19;
      uiAmountB = uiAmountB * 0.19;
      console.log(`USDC detected. Halving amount B to: ${uiAmountB}`);
        console.log(`Token A balance: ${uiAmountA}`);
        console.log(`Token B balance: ${uiAmountB}`);
    

    const tokenMintA = new PublicKey(mintA);
    const tokenMintB = new PublicKey(mintB);
    const funder = provider.wallet.publicKey;
    
    const initialPrice = new Decimal(uiAmountB / uiAmountA);
    

      const fetcher = buildDefaultAccountFetcher(connection as any);
      // @ts-ignore
      const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID, fetcher);
      const client = buildWhirlpoolClient(ctx);

      const mintInfos = await fetcher.getMintInfos(
        [tokenMintA, tokenMintB],
        {},
      );
      const tokenExtensionCtx: TokenExtensionContextForPool = {
        ...NO_TOKEN_EXTENSION_CONTEXT,
        tokenMintWithProgramA: mintInfos.get(tokenMintA.toString())!,
        tokenMintWithProgramB: mintInfos.get(tokenMintB.toString())!,
      };
      // Initialize config
      const configKeypair = Keypair.generate();
      const configInitIx = await WhirlpoolIx.initializeConfigIx(ctx.program, {
        // @ts-ignore
        whirlpoolsConfigKeypair: configKeypair,
        feeAuthority: provider.wallet.publicKey,
        collectProtocolFeesAuthority: provider.wallet.publicKey,
        rewardEmissionsSuperAuthority: provider.wallet.publicKey,
        defaultProtocolFeeRate: 666, // 0.3%
        funder: provider.wallet.publicKey,
      });
      const txBuilder = new TransactionBuilder(
        provider.connection,
        provider.wallet,
      )
      txBuilder.addInstruction(configInitIx);
         txBuilder.addSigner(configKeypair);

      // Initialize config extension
      const configExtensionIx = await WhirlpoolIx.initializeConfigExtensionIx(ctx.program, {
        whirlpoolsConfig: configKeypair.publicKey,
        whirlpoolsConfigExtensionPda: PDAUtil.getConfigExtension(ORCA_WHIRLPOOL_PROGRAM_ID, configKeypair.publicKey),
        funder: provider.wallet.publicKey,
        feeAuthority: provider.wallet.publicKey,
      });
      txBuilder.addInstruction(configExtensionIx);
     const whirlpoolsConfig = AddressUtil.toPubKey(configKeypair.publicKey);

      // Initialize token badge for 44cUrGxdhJLe4bZCRUfRgyekWHG2HdGeeMVb9Eid7uXy
      const tokenBadgePda = PDAUtil.getTokenBadge(
        ORCA_WHIRLPOOL_PROGRAM_ID,
        whirlpoolsConfig,
        mintb
      );
      const tokenBadgeIx = await WhirlpoolIx.initializeTokenBadgeIx(ctx.program, {
        whirlpoolsConfig: whirlpoolsConfig,
        whirlpoolsConfigExtension: PDAUtil.getConfigExtension(ORCA_WHIRLPOOL_PROGRAM_ID, whirlpoolsConfig).publicKey,
        tokenBadgeAuthority: provider.wallet.publicKey,
        tokenMint: mintb,
        tokenBadgePda: tokenBadgePda,
        funder: provider.wallet.publicKey,
      });
     txBuilder.addInstruction(tokenBadgeIx);
      // Initialize fee tier
      const feeTierInitIx = await WhirlpoolIx.initializeFeeTierIx(ctx.program, {
        whirlpoolsConfig: whirlpoolsConfig,
        feeTierPda: PDAUtil.getFeeTier(
          ORCA_WHIRLPOOL_PROGRAM_ID,
          whirlpoolsConfig,
          SPLASH_POOL_TICK_SPACING
        ),
        tickSpacing: SPLASH_POOL_TICK_SPACING,
        defaultFeeRate: 3000, // 0.3%
        feeAuthority: provider.wallet.publicKey,
        funder: provider.wallet.publicKey,
      });
     txBuilder.addInstruction(feeTierInitIx);
      const feeTierKey = PDAUtil.getFeeTier(
        ORCA_WHIRLPOOL_PROGRAM_ID,
        whirlpoolsConfig,
        SPLASH_POOL_TICK_SPACING
      ).publicKey;
  
      const whirlpoolPda = PDAUtil.getWhirlpool(
        ORCA_WHIRLPOOL_PROGRAM_ID,
        whirlpoolsConfig,
        new PublicKey(tokenMintA),
        new PublicKey(tokenMintB),
        SPLASH_POOL_TICK_SPACING,
      );
  
      const tokenDecimalsA = mintInfos.get(tokenMintA.toString())?.decimals ?? 0;
      const tokenDecimalsB = mintInfos.get(tokenMintB.toString())?.decimals ?? 0;
      
      const initSqrtPrice = PriceMath.priceToSqrtPriceX64(
        initialPrice,
        tokenDecimalsA,
        tokenDecimalsB,
      );
      const tokenVaultAKeypair = Keypair.generate();
      const tokenVaultBKeypair = Keypair.generate();
  
  
      const tokenBadgeA = PDAUtil.getTokenBadge(
        ORCA_WHIRLPOOL_PROGRAM_ID,
        whirlpoolsConfig,
        AddressUtil.toPubKey(tokenMintA),
      ).publicKey;
      const tokenBadgeB = PDAUtil.getTokenBadge(
        ORCA_WHIRLPOOL_PROGRAM_ID,
        whirlpoolsConfig,
        AddressUtil.toPubKey(tokenMintB),
      ).publicKey;
  
      const baseParams = {
        initSqrtPrice,
        whirlpoolsConfig,
        whirlpoolPda,
        tokenMintA: new PublicKey(tokenMintA),
        tokenMintB: new PublicKey(tokenMintB),
        tokenVaultAKeypair,
        tokenVaultBKeypair,
        feeTierKey,
        tickSpacing: SPLASH_POOL_TICK_SPACING,
        funder: new PublicKey(funder),
      };
      const program = ctx.program;
      const initPoolIx = !TokenExtensionUtil.isV2IxRequiredPool(tokenExtensionCtx)
      // @ts-ignore
        ? WhirlpoolIx.initializePoolIx(program, baseParams)
        : WhirlpoolIx.initializePoolV2Ix(ctx.program, 
              // @ts-ignore
          {
               // @ts-ignore

            ...baseParams,
            tokenProgramA: tokenExtensionCtx.tokenMintWithProgramA.tokenProgram,
            tokenProgramB: tokenExtensionCtx.tokenMintWithProgramB.tokenProgram,
            tokenBadgeA,
            tokenBadgeB,
          });
  
     txBuilder.addInstruction(initPoolIx);
  
      const [startTickIndex, endTickIndex] = TickUtil.getFullRangeTickIndex(
        SPLASH_POOL_TICK_SPACING,
      );
      const startInitializableTickIndex = TickUtil.getStartTickIndex(
        startTickIndex,
        SPLASH_POOL_TICK_SPACING,
      );
      const endInitializableTickIndex = TickUtil.getStartTickIndex(
        endTickIndex,
        SPLASH_POOL_TICK_SPACING,
      );
  
      const startTickArrayPda = PDAUtil.getTickArray(
        ORCA_WHIRLPOOL_PROGRAM_ID,
        whirlpoolPda.publicKey,
        startInitializableTickIndex,
      );
  
      const endTickArrayPda = PDAUtil.getTickArray(
        ORCA_WHIRLPOOL_PROGRAM_ID,
        whirlpoolPda.publicKey,
        endInitializableTickIndex,
      );
  
      txBuilder.addInstruction(
        // @ts-ignore
        initTickArrayIx(ctx.program, {
          startTick: startInitializableTickIndex,
          tickArrayPda: startTickArrayPda,
          whirlpool: whirlpoolPda.publicKey,
          funder: AddressUtil.toPubKey(funder),
        }),
      );
  
      txBuilder.addInstruction(
                // @ts-ignore
        initTickArrayIx(ctx.program, {
          startTick: endInitializableTickIndex,
          tickArrayPda: endTickArrayPda,
          whirlpool: whirlpoolPda.publicKey,
          funder: AddressUtil.toPubKey(funder),
        })

      );
     await txBuilder  .prependInstruction(useMaxCU()).buildAndExecute()
     await new Promise(resolve => setTimeout(resolve, 25000));
  const pool = await client.getPool(new PublicKey(whirlpoolPda.publicKey));

    const fullRange = TickUtil.getFullRangeTickIndex(pool.getData().tickSpacing);

      // create 2 position (small & large)
      const depositQuoteSmall = increaseLiquidityQuoteByInputToken(
        tokenMintA,
        new Decimal(Number(tokenBalanceA.value.uiAmount)*0.49),
        fullRange[0],
        fullRange[1],
        Percentage.fromFraction(20, 100),
        pool,
        NO_TOKEN_EXTENSION_CONTEXT,
      );
      const positionMintKeypair = Keypair.generate();
      const positionPda = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, positionMintKeypair.publicKey);
      const positionTokenAccountAddress = getAssociatedTokenAddressSync(
        positionMintKeypair.publicKey,
        wallet.publicKey,
        true,
      );
      const openPositionParams = {
        tickLowerIndex: fullRange[0],
        tickUpperIndex: fullRange[1],
        whirlpool: whirlpoolPda.publicKey,
        positionPda: positionPda,
        positionMintAddress: positionMintKeypair.publicKey,
        positionTokenAccount: positionTokenAccountAddress,
        funder: wallet.publicKey,
        owner: wallet.publicKey,
      };

      const openPositionIx = WhirlpoolIx.openPositionIx(ctx.program, openPositionParams);
      let txx =  new TransactionBuilder(
        provider.connection,
        provider.wallet,
      )

      
      txx.addInstruction(openPositionIx);
      txx.addSigner(positionMintKeypair);    
console.log(121123)
      await txx. prependInstruction(useMaxCU()).buildAndExecute()
      console.log(121123)
      console.log(121123)
      txx =  new TransactionBuilder(
        provider.connection,
        provider.wallet,
      )
      // Execute the transaction to open the position
      await new Promise(resolve => setTimeout(resolve, 15000));
      const tokenTransferHookAccountsA =
      await getExtraAccountMetasForTestTransferHookProgram(
        provider,
        mintA,
        tokenAccountA, 
        pool.getTokenVaultAInfo().address,
        wallet.publicKey,
        new PublicKey("AxaViNQ6EwvHuhAXXgsHkjAVXJdRTemYJeJEepaT8zDX")
      )
      const tokenTransferHookAccountsB =
      await getExtraAccountMetasForTestTransferHookProgram(
        provider,
        mintB,
        tokenAccountB, 
        pool.getTokenVaultBInfo().address,
        wallet.publicKey,
        new PublicKey("AxaViNQ6EwvHuhAXXgsHkjAVXJdRTemYJeJEepaT8zDX")
      )
      console.log(tokenTransferHookAccountsB)
      console.log(tokenTransferHookAccountsA)
      // Wait for a short time to ensure the transaction is confirmed
      const addLiquidityParams: IncreaseLiquidityV2Params = {
        liquidityAmount: depositQuoteSmall.liquidityAmount,
        tokenMaxA: depositQuoteSmall.tokenMaxA,
        tokenMaxB: depositQuoteSmall.tokenMaxB,
        whirlpool: whirlpoolPda.publicKey,
        position: positionPda.publicKey,
        positionTokenAccount: positionTokenAccountAddress,
        positionAuthority: wallet.publicKey,
        tokenMintA: tokenMintA,
        tokenMintB: tokenMintB,
        tokenOwnerAccountA: tokenAccountA,
        tokenOwnerAccountB: tokenAccountB,
        tokenVaultA: pool.getTokenVaultAInfo().address,
        tokenVaultB: pool.getTokenVaultBInfo().address,
        tokenProgramA: aiAccountA.owner,
        tokenProgramB: aiAccountB.owner,
        tickArrayLower: startTickArrayPda.publicKey,
        tickArrayUpper: endTickArrayPda.publicKey,
        tokenTransferHookAccountsA,
        tokenTransferHookAccountsB
      };
      
      let tx2 = await txx
     .prependInstruction(useMaxCU())

        .addInstruction(
          WhirlpoolIx.increaseLiquidityV2Ix(ctx.program, addLiquidityParams)
        )
        .buildAndExecute({}, {skipPreflight: true});
        console.log(tx2)
      
/*
        const [startTickIndex, endTickIndex] = TickUtil.getFullRangeTickIndex(
          SPLASH_POOL_TICK_SPACING,
        );
        const startInitializableTickIndex = TickUtil.getStartTickIndex(
          startTickIndex,
          SPLASH_POOL_TICK_SPACING,
        );
        const endInitializableTickIndex = TickUtil.getStartTickIndex(
          endTickIndex,
          SPLASH_POOL_TICK_SPACING,
        );
    
        const startTickArrayPda = PDAUtil.getTickArray(
          ORCA_WHIRLPOOL_PROGRAM_ID,
          whirlpoolPda.publicKey,
          startInitializableTickIndex,
        );
    
        const endTickArrayPda = PDAUtil.getTickArray(
          ORCA_WHIRLPOOL_PROGRAM_ID,
          whirlpoolPda.publicKey,
          endInitializableTickIndex,
        );
        const pool = await client.getPool(new PublicKey(whirlpoolPda.publicKey));
      // Determine if we're swapping from USDC to SOL (A to B) or vice versa
      const usdcMint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC mint address
      const solMint = NATIVE_MINT; // SOL mint address
      let aToB: boolean;
      if (pool.getTokenAInfo().mint.equals(usdcMint) || pool.getTokenAInfo().mint.equals(solMint)) {
        aToB = pool.getTokenAInfo().mint.equals(usdcMint)  || pool.getTokenAInfo().mint.equals(solMint)// true if A is USDC, false if A is SOL
      } else {
        console.log("Pool does not contain USDC or SOL");
      }

      console.log(`Swapping from ${aToB ? "USDC to SOL" : "SOL to USDC"}`);


      const tokenTransferHookAccountsA =
      await getExtraAccountMetasForTestTransferHookProgram(
        provider,
        mintA,
        tokenAccountA, 
        pool.getTokenVaultAInfo().address,
        wallet.publicKey,
        new PublicKey("AxaViNQ6EwvHuhAXXgsHkjAVXJdRTemYJeJEepaT8zDX")
      )
      const tokenTransferHookAccountsB =
      await getExtraAccountMetasForTestTransferHookProgram(
        provider,
        mintB,
        tokenAccountB, 
        pool.getTokenVaultBInfo().address,
        wallet.publicKey,
        new PublicKey("AxaViNQ6EwvHuhAXXgsHkjAVXJdRTemYJeJEepaT8zDX")
      )
      // Perform a swap for 1 token
      const swapParams = {
        amount: new BN(1000000), // Swap 1 token
        otherAmountThreshold: new BN(0), // Set to 0 for simplicity, adjust as needed
        sqrtPriceLimit: aToB ? PriceMath.tickIndexToSqrtPriceX64(MIN_TICK) : PriceMath.tickIndexToSqrtPriceX64(MAX_TICK),
        amountSpecifiedIsInput: true,
        aToB: true, // Swap A to B, adjust if needed
        whirlpool: whirlpoolPda.publicKey,
        tokenAuthority: wallet.publicKey,
        tokenOwnerAccountA: tokenAccountA,
        tokenOwnerAccountB: tokenAccountB,
        tokenVaultA: pool.getTokenVaultAInfo().address,
        tokenVaultB: pool.getTokenVaultBInfo().address,
        tickArray0: startTickArrayPda.publicKey,
        tickArray1: endTickArrayPda.publicKey,
        tickArray2: endTickArrayPda.publicKey, // Using the same tick array for simplicity
        oracle: PDAUtil.getOracle(ORCA_WHIRLPOOL_PROGRAM_ID, whirlpoolPda.publicKey).publicKey,
        tokenMintA: pool.getTokenAInfo().mint,
        tokenMintB: pool.getTokenBInfo().mint,
        tokenProgramA: pool.getTokenAInfo().tokenProgram,
        tokenProgramB: pool.getTokenBInfo().tokenProgram,
        tokenTransferHookAccountsA,
        tokenTransferHookAccountsB
      };

      let swapTx = new TransactionBuilder(connection, wallet)
        .addInstruction(useMaxCU())
        .addInstruction(WhirlpoolIx.swapV2Ix(ctx.program, swapParams))
       

      console.log("Executing swap transaction...");
      const swapSignature = await swapTx.buildAndExecute();
      console.log("Swap transaction signature:", swapSignature);

      // Wait for confirmation
      await ctx.connection.confirmTransaction(swapSignature, "confirmed");
      console.log("Swap transaction confirmed");
      return {
        poolKey: whirlpoolPda.publicKey,
        tx: txBuilder
      };*/
}


 function useCU(cu: number): Instruction {
  return {
    cleanupInstructions: [],
    signers: [],
    instructions: [
     
      ComputeBudgetProgram.setComputeUnitLimit({
        units: 1_400_000, // Request 1MB of heap
      }),
      ComputeBudgetProgram.requestHeapFrame({
        bytes: 1024 * 256, // Request 1MB of heap
      })
    ],
  };
}

 function useMaxCU(): Instruction {
  return useCU(1_400_000);
}
 
import fetch from 'node-fetch';
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import * as fs from 'fs';
import { ApiV3PoolInfoConcentratedItem, bool, CLMM_PROGRAM_ID, ClmmKeys, getPdaPersonalPositionAddress, getPdaProtocolPositionAddress, MAX_TICK, METADATA_PROGRAM_ID, MIN_TICK, parseTokenAccountResp, PoolUtils, PositionInfoLayout, publicKey, Raydium, RENT_PROGRAM_ID, s32, struct, TickUtils, u128, u64, u8 } from "@raydium-io/raydium-sdk-v2";
import { MintLayout } from "@solana/spl-token";
import { buildDefaultAccountFetcher, buildWhirlpoolClient, increaseLiquidityQuoteByInputToken, IncreaseLiquidityV2Params, ORCA_WHIRLPOOL_PROGRAM_ID, PDAUtil, PoolUtil, PriceMath, TickUtil, TokenExtensionUtil, WhirlpoolContext, WhirlpoolIx } from "../whirlpools/legacy-sdk/whirlpool/src"
import { C } from "@raydium-io/raydium-sdk-v2/lib/raydium-53c4348a";
import {  TickSpacing } from "../whirlpools/legacy-sdk/whirlpool/tests/utils";

interface RaydiumPoolInfo {
  id: string;
  mintProgramIdA: string;
  mintProgramIdB: string;
  mintA: string;
  mintB: string;
  vaultA: string;
  vaultB: string;
  mintDecimalsA: number;
  mintDecimalsB: number;
  ammConfig: {
    id: string;
    index: number;
    protocolFeeRate: number;
    tradeFeeRate: number;
    tickSpacing: number;
    fundFeeRate: number;
    fundOwner: string;
    description: string;
  };
  rewardInfos: Array<{
    mint: string;
    programId: string;
  }>;
  tvl: number;
  day: {
    volume: number;
    volumeFee: number;
    feeA: number;
    feeB: number;
    feeApr: number;
    rewardApr: {
      A: number;
      B: number;
      C: number;
    };
    apr: number;
    priceMin: number;
    priceMax: number;
  };
  week: {
    volume: number;
    volumeFee: number;
    feeA: number;
    feeB: number;
    feeApr: number;
    rewardApr: {
      A: number;
      B: number;
      C: number;
    };
    apr: number;
    priceMin: number;
    priceMax: number;
  };
  month: {
    volume: number;
    volumeFee: number;
    feeA: number;
    feeB: number;
    feeApr: number;
    rewardApr: {
      A: number;
      B: number;
      C: number;
    };
    apr: number;
    priceMin: number;
    priceMax: number;
  };
  lookupTableAccount?: string;
  openTime: number;
  price: number;
}

 async function getOwnerPositionInfo({
  programId,
  thiss
}: {
  programId: string | PublicKey;
  thiss: any;
}): Promise<any[]> {
  await thiss.scope.account.fetchWalletTokenAccounts();
  const balanceMints = thiss.scope.account.tokenAccountRawInfos.filter((acc) => acc.accountInfo.amount.eq(new BN(1)));
  const allPositionKey = balanceMints.map(
    (acc) => getPdaPersonalPositionAddress(new PublicKey(programId), acc.accountInfo.mint).publicKey,
  );

  const allPosition: ReturnType<typeof PositionInfoLayout.decode>[] = [];
  for (let i = 0; i < allPositionKey.length; i += 100) {
    const batch = allPositionKey.slice(i, i + 100);
    const accountInfoBatch = await thiss.scope.connection.getMultipleAccountsInfo(batch);
    accountInfoBatch.forEach((positionRes) => {
      if (!positionRes) return;
      const position = PositionInfoLayout.decode(positionRes.data);
      allPosition.push(position);
    });
  }

  return allPosition;
}

export const closePosition = async (raydium, poolId) => {
  let poolInfo: ApiV3PoolInfoConcentratedItem
  // SOL-USDC pool
  let poolKeys: ClmmKeys | undefined

  if (raydium.cluster === 'mainnet') {
    // note: api doesn't support get devnet pool info, so in devnet else we go rpc method
    // if you wish to get pool info from rpc, also can modify logic to go rpc method directly
    const data = await raydium.api.fetchPoolById({ ids: poolId })
    poolInfo = data[0] as ApiV3PoolInfoConcentratedItem
  } else {
    const data = await raydium.clmm.getPoolInfoFromRpc(poolId)
    poolInfo = data.poolInfo
    poolKeys = data.poolKeys
  }

  /** code below will get on chain realtime price to avoid slippage error, uncomment it if necessary */
  // const rpcData = await raydium.clmm.getRpcClmmPoolInfo({ poolId: poolInfo.id })
  // poolInfo.price = rpcData.currentPrice

  const allPosition = await getOwnerPositionInfo({ thiss:raydium.clmm,programId: poolInfo.programId})
  if (!allPosition.length) return
  const position = allPosition.reduce((selected, position) => 
    Math.random() < 1/selected.length ? position : selected
  , [allPosition[0]])

  if (!position) console.log('Failed to select a random position')
    if (position.poolId.toBase58() === poolInfo.id) {
      try {
        // Remove liquidity, collect fees and rewards before closing position
        const { execute: removeExecute } = await raydium.clmm.decreaseLiquidity({
          poolInfo,
          poolKeys,
          ownerPosition: position,
          ownerInfo: {
            useSOLBalance: true,
            closePosition: true,
          },
          liquidity: position.liquidity,
          amountMinA: new BN(0),
          amountMinB: new BN(0),
          txVersion: 0,
        });
        
        try {
          const { txId: removeTxId } = await removeExecute({ sendAndConfirm: true });
          console.log('Liquidity removed:', { txId: `https://explorer.solana.com/tx/${removeTxId}` });
        } catch (error) {
          console.error('Failed to remove liquidity:', error);
        }

        // Collect fees and rewards
        const { execute: collectExecute } = await raydium.clmm.harvestAllRewards({
          allPoolInfo: { [poolInfo.id]: poolInfo },
          allPositions: { [poolInfo.id]: [position] },
          ownerInfo: {
            useSOLBalance: true,
          },
          programId: CLMM_PROGRAM_ID, // Use DEVNET_PROGRAM_ID.CLMM for devnet
          txVersion:0,
        });

        try {
          const { txId: collectTxId } = await collectExecute({ sendAndConfirm: true });
          console.log('Fees and rewards collected:', { txId: `https://explorer.solana.com/tx/${collectTxId}` });
        } catch (error) {
          console.error('Failed to collect fees and rewards:', error);
        }

        // Now proceed with closing the position
        const { execute } = await raydium.clmm.closePosition({
          poolInfo,
          poolKeys,
          ownerPosition: position,
          txVersion: 0,
        });

        // don't want to wait confirm, set sendAndConfirm to false or don't pass any params to execute
        const { txId } = await execute({ sendAndConfirm: true });
        console.log('clmm position closed:', { txId: `https://explorer.solana.com/tx/${txId}` });
      } catch (error) {
        console.error(`Failed to close position in pool ${poolInfo.id}:`, error);
      }
    }
}

const RAYDIUM_PROGRAM_ID = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");

async function initRaydiumPool(mintA: PublicKey, mintB: PublicKey = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")) {//new PublicKey("69kdRLyP5DTRkpHraaSZAQbWmAwzF9guKjZfzMXzcbAs")) {
  console.log("Initializing Raydium pool...");

  // Setup connection and wallet
  const connection = new Connection("https://rpc.ironforge.network/mainnet?apiKey=01HRZ9G6Z2A19FY8PR4RF4J4PW", "confirmed");
  let wallet: Wallet;
  try {
    const keypairData = JSON.parse(fs.readFileSync('/Users/jarettdunn/99.json', 'utf-8'));
    wallet = new Wallet(Keypair.fromSecretKey(new Uint8Array(keypairData)));
  } catch (error) {
    console.error("Failed to load wallet:", error);
    console.log("Wallet initialization failed");
  }
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  const program = new Program(JSON.parse(fs.readFileSync('./target/idl/transfer_hook.json').toString()) as TransferHook, provider)
  const programeco = new Program(JSON.parse(fs.readFileSync('./target/idl/ecosystem_transfer_hook.json').toString()) as EcosystemTransferHook, provider)

  // Fetch token info
  console.log("Fetching token information...");
  const [mintInfoA, mintInfoB] = await Promise.all([
    getMint(connection, mintA),
    getMint(connection, mintB)
  ]);

  // Fetch Raydium AMM pools
  console.log("Fetching Raydium AMM pools...");
  let pools: RaydiumPoolInfo[];
  try {
    const response = await fetch('https://api.raydium.io/v2/ammV3/ammPools');
    pools = (await response.json()).data;
  } catch (error) {
    pools = JSON.parse(fs.readFileSync('./ammPools').toString()).data;
    console.error("Failed to fetch Raydium pools:", error);
  }

  // Find existing pool with USDC mint
  let pool = pools.filter(p => 
    ((p.mintA === mintA.toBase58() && p.mintB ==mintB.toBase58())|| 
    (p.mintB === mintA.toBase58()&& p.mintA == mintB.toBase58())) && p.rewardInfos.length == 0
  )[0]
  console.log("Initializing Extra Account Meta Lists...");
  const keypairData = JSON.parse(fs.readFileSync('/Users/jarettdunn/99.json', 'utf-8'));
  
  // Initialize Raydium SDK
  const raydium = await Raydium.load({
    connection,
    owner: Keypair.fromSecretKey(new Uint8Array(keypairData)),
    disableLoadToken: false
  });
  closePosition(raydium, new PublicKey(pool.id))
  if (!pool) {
    console.log("Pool doesn't exist. Aborting...");
    console.log("Pool not found");
  } else {
    console.log("Existing pool found:", pool.id);
  }

  // Determine base and quote mints based on pool configuration
  const [baseMint, quoteMint] = pool.mintA === mintA.toBase58() ? [mintInfoA, mintInfoB] : [mintInfoB, mintInfoA];

  console.log(`Base Token: ${baseMint.address.toBase58()}`);
  console.log(`Quote Token: ${quoteMint.address.toBase58()}`);

  // Get token account balances
  console.log("Fetching token balances...");
  const [tokenAccountA, tokenAccountB] = await Promise.all([
    getOrCreateAssociatedTokenAccount(connection, wallet.payer, new PublicKey(pool.mintA), wallet.publicKey),
    getOrCreateAssociatedTokenAccount(connection, wallet.payer, new PublicKey(pool.mintB), wallet.publicKey)
  ]);

  const [tokenBalanceA, tokenBalanceB] = await Promise.all([
    connection.getTokenAccountBalance(tokenAccountA.address),
    connection.getTokenAccountBalance(tokenAccountB.address)
  ]);

  console.log(`Base Token (${baseMint.address.toBase58()}) balance: ${tokenBalanceA.value.uiAmount}`);
  console.log(`Quote Token (${quoteMint.address.toBase58()}) balance: ${tokenBalanceB.value.uiAmount}`);

  // Prepare to add liquidity
  console.log("Preparing to add liquidity...");
  const baseAmount = new Decimal(tokenBalanceA.value.uiAmount).mul(0.1).toFixed(baseMint.decimals); // Use 1% of balance
  const quoteAmount = new Decimal(tokenBalanceB.value.uiAmount).mul(0.1).toFixed(quoteMint.decimals); // Use 1% of balance

  console.log(`Base amount to add: ${baseAmount}`);
  console.log(`Quote amount to add: ${quoteAmount}`);

  

  // Fetch token account data
  const solAccountResp = await connection.getAccountInfo(wallet.publicKey);
  const tokenAccountResp = await connection.getTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID });
  const token2022Req = await connection.getTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_2022_PROGRAM_ID });
  const tokenAccountData = parseTokenAccountResp({
    owner: wallet.publicKey,
    solAccountResp,
    tokenAccountResp: {
      context: tokenAccountResp.context,
      value: [...tokenAccountResp.value, ...token2022Req.value],
    },
  });

  // Fetch pool info
  let poolInfo: ApiV3PoolInfoConcentratedItem;
  let poolKeys: ClmmKeys | undefined;

 
    const data = await raydium.clmm.getPoolInfoFromRpc(pool.id);
    poolInfo = data.poolInfo;
    poolKeys = data.poolKeys;

  if (!poolInfo) {
    console.log("Pool information not found");
  }



  console.log("Existing pool found:", pool.id);
  // Get token account balances
  const taa = tokenAccountData.tokenAccounts.find(acc => acc.mint.equals(new PublicKey(pool.mintA)));
  const tab = tokenAccountData.tokenAccounts.find(acc => acc.mint.equals(new PublicKey(pool.mintB)));

  if (!tokenAccountA || !tokenAccountB) {
    console.log("Token accounts not found");
  }

  console.log(`Token A (${mintA.toBase58()}) balance: ${taa.amount}`);
  console.log(`Token B (${mintB.toBase58()}) balance: ${tab.amount}`);
  const res2 = await raydium.clmm.getRpcClmmPoolInfos({
    poolIds: [pool.id],
  });
  const poolState = res2[pool.id];
  const sqrtPriceX64 = poolState.sqrtPriceX64;
  const currentTickIndex = poolState.tickCurrent;
  const price = PriceMath.tickIndexToPrice(currentTickIndex, poolInfo.mintA.decimals, poolInfo.mintB.decimals);
  const targetPrice = price.mul(new Decimal(1.02)); // Set target price 1% higher
  const [startPrice, endPrice] = [price.mul(new Decimal(0.98)), targetPrice]; // Price range from 1% below to 1% above current price
  console.log(`Current price: ${price.toFixed(6)}, Target price: ${targetPrice.toFixed(6)}`);
  console.log(`Price range: ${startPrice.toFixed(6)} - ${endPrice.toFixed(6)}`);


  // Prepare to add liquidity
  console.log("Preparing to add liquidity...");
  const ba = new BN(Number(baseAmount) * 10 ** poolInfo.mintA.decimals);
  const qa = new BN(Number(quoteAmount) * 10 ** poolInfo.mintB.decimals);

  const { tick: lowerTick } = TickUtils.getPriceAndTick({
    poolInfo,
    price: new Decimal(startPrice),
    baseIn: true,
  })

  const { tick: upperTick } = TickUtils.getPriceAndTick({
    poolInfo,
    price: new Decimal(endPrice),
    baseIn: true,
  })
  const epochInfo = await raydium.fetchEpochInfo()
  // Debug logging
  console.log("Pool Info:", poolInfo);
  console.log("Lower Tick:", lowerTick);
  console.log("Upper Tick:", upperTick);
  console.log("Amount (ba):", ba.toString());

  const res = await PoolUtils.getLiquidityAmountOutFromAmountIn({
    poolInfo,
    slippage: 0.1, // Add a small slippage to avoid precision issues
    inputA: poolInfo.mintA.address==((pool.mintA)), // Ensure correct input token
    tickUpper: Math.max(lowerTick, upperTick),
    tickLower: Math.min(lowerTick, upperTick),
    amount: ba,
    add: true,
    amountHasFee: false, // Change to false if the amount doesn't include fees
    epochInfo: epochInfo,
  });

  // Check the result
  console.log("Liquidity calculation result:", res);
  if (res.liquidity.eq(new BN(0))) {
    console.error("Liquidity is zero. Possible issues:");
    console.error("1. Amount might be too small");
    console.error("2. Price range might be too narrow");
    console.error("3. Pool might have very low liquidity");
    console.log("Failed to calculate non-zero liquidity");
  }

const anchorDataBuf = {
  createPool: [233, 146, 209, 142, 207, 104, 64, 188],
  initReward: [95, 135, 192, 196, 242, 129, 230, 68],
  setRewardEmissions: [112, 52, 167, 75, 32, 201, 211, 137],
  openPosition: [77, 184, 74, 214, 112, 86, 241, 199],
  closePosition: [123, 134, 81, 0, 49, 68, 98, 98],
  increaseLiquidity: [133, 29, 89, 223, 69, 238, 176, 10],
  decreaseLiquidity: [58, 127, 188, 62, 79, 82, 196, 96],
  swap: [43, 4, 237, 11, 26, 201, 30, 98], // [248, 198, 158, 145, 225, 117, 135, 200],
  collectReward: [18, 237, 166, 197, 34, 16, 213, 144],
};

function openPositionFromBaseInstruction(
  programId: PublicKey,
  payer: PublicKey,
  poolId: PublicKey,
  positionNftOwner: PublicKey,
  positionNftMint: PublicKey,
  positionNftAccount: PublicKey,
  metadataAccount: PublicKey,
  protocolPosition: PublicKey,
  tickArrayLower: PublicKey,
  tickArrayUpper: PublicKey,
  personalPosition: PublicKey,
  ownerTokenAccountA: PublicKey,
  ownerTokenAccountB: PublicKey,
  tokenVaultA: PublicKey,
  tokenVaultB: PublicKey,
  tokenMintA: PublicKey,
  tokenMintB: PublicKey,

  tickLowerIndex: number,
  tickUpperIndex: number,
  tickArrayLowerStartIndex: number,
  tickArrayUpperStartIndex: number,

  withMetadata: "create" | "no-create",
  base: "MintA" | "MintB",
  baseAmount: anchor.BN,

  otherAmountMax: anchor.BN,
  liquidity: anchor.BN,
  exTickArrayBitmap?: PublicKey,
): TransactionInstruction {
  const dataLayout = struct([
    s32("tickLowerIndex"),
    s32("tickUpperIndex"),
    s32("tickArrayLowerStartIndex"),
    s32("tickArrayUpperStartIndex"),
    u128("liquidity"),
    u64("amountMaxA"),
    u64("amountMaxB"),
    bool("withMetadata"),
    u8("optionBaseFlag"),
    bool("baseFlag"),
  ]);

  const remainingAccounts = [
    ...(exTickArrayBitmap ? [{ pubkey: exTickArrayBitmap, isSigner: false, isWritable: true }] : []),
  ];

  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: positionNftOwner, isSigner: false, isWritable: false },
    { pubkey: positionNftMint, isSigner: true, isWritable: true },
    { pubkey: positionNftAccount, isSigner: false, isWritable: true },
    { pubkey: metadataAccount, isSigner: false, isWritable: true },
    { pubkey: poolId, isSigner: false, isWritable: true },
    { pubkey: protocolPosition, isSigner: false, isWritable: true },
    { pubkey: tickArrayLower, isSigner: false, isWritable: true },
    { pubkey: tickArrayUpper, isSigner: false, isWritable: true },
    { pubkey: personalPosition, isSigner: false, isWritable: true },
    { pubkey: ownerTokenAccountA, isSigner: false, isWritable: true },
    { pubkey: ownerTokenAccountB, isSigner: false, isWritable: true },
    { pubkey: tokenVaultA, isSigner: false, isWritable: true },
    { pubkey: tokenVaultB, isSigner: false, isWritable: true },

    { pubkey: RENT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },

    { pubkey: tokenMintA, isSigner: false, isWritable: false },
    { pubkey: tokenMintB, isSigner: false, isWritable: false },

    ...remainingAccounts,
  ];

  const data = Buffer.alloc(dataLayout.span);
  dataLayout.encode(
    {
      tickLowerIndex,
      tickUpperIndex,
      tickArrayLowerStartIndex,
      tickArrayUpperStartIndex,
      liquidity,
      amountMaxA: base === "MintA" ? baseAmount : otherAmountMax,
      amountMaxB: base === "MintA" ? otherAmountMax : baseAmount,
      withMetadata: withMetadata === "create",
      baseFlag: base === "MintA",
      optionBaseFlag: 1,
    },
    data,
  );

  const aData = Buffer.from([...anchorDataBuf.openPosition, ...data]);

  return new TransactionInstruction({
    keys,
    programId,
    data: aData,
  });
}

const nftMint = Keypair.generate()
  const ix = openPositionFromBaseInstruction(
    RAYDIUM_PROGRAM_ID,
    wallet.publicKey,
    new PublicKey(pool.id),
    wallet.publicKey,
    nftMint.publicKey,
    getAssociatedTokenAddressSync(nftMint.publicKey, wallet.publicKey, true),
    PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), nftMint.publicKey.toBuffer()],
      METADATA_PROGRAM_ID
    )[0],
    getPdaProtocolPositionAddress(RAYDIUM_PROGRAM_ID, new PublicKey(pool.id), Math.min(lowerTick, upperTick), Math.max(lowerTick, upperTick)).publicKey,
    TickUtils.getTickArrayAddressByTick(
      RAYDIUM_PROGRAM_ID,
      new PublicKey(pool.id),
      Math.min(lowerTick, upperTick),
      pool.ammConfig.tickSpacing
    ),
    TickUtils.getTickArrayAddressByTick(
      RAYDIUM_PROGRAM_ID,
      new PublicKey(pool.id),
      Math.max(lowerTick, upperTick),
      pool.ammConfig.tickSpacing
    ),
    getPdaPersonalPositionAddress(RAYDIUM_PROGRAM_ID, nftMint.publicKey).publicKey,
    tokenAccountA.address,
    tokenAccountB.address,
    new PublicKey(pool.vaultA),
    new PublicKey(pool.vaultB),
    new PublicKey(pool.mintA),
    new PublicKey(pool.mintB),
    Math.min(lowerTick, upperTick),
    Math.max(lowerTick, upperTick),
    TickUtils.getTickArrayStartIndexByTick(Math.min(lowerTick, upperTick), pool.ammConfig.tickSpacing),
    TickUtils.getTickArrayStartIndexByTick(Math.max(lowerTick, upperTick), pool.ammConfig.tickSpacing),
    "no-create",
    "MintA",
    res.amountA.amount,
    res.amountSlippageA.amount,
    res.liquidity
  );
  
  // Perform token transfers
  const amount = 1;
  const bigIntAmount = BigInt(amount);

  const [game, bump] = PublicKey.findProgramAddressSync(
    [ Buffer.from("gg"), new PublicKey(pool.id).toBuffer()],
    program.programId
  );
  console.log(bump, bump,bump, bump,bump, bump,bump, bump,bump, bump,bump, bump)
  const ga = await program.account.game.fetch(game)
  console.log(ga)
  const mint = {publicKey: ga.mint}
  const otherMint = {publicKey: ga.otherMint}
  const gameAccount = {mint: mint.publicKey, otherMint: otherMint.publicKey}
console.log('gameaccount', gameAccount)
await initSplashPoolWithTransferHook(mint.publicKey, new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), NATIVE_MINT, new PublicKey("Cc7Y5m3XzFncpNSuFiobKGJJrUtTbhyw4ubim8MR9snz"))


//await initSplashPoolWithTransferHook(otherMint.publicKey, new PublicKey("GGo8ee2DkuX2oFminYuBphMwEiQ5BdCzyYd84Nnm24R5"), new PublicKey("Anot3HBvWpFhtKjro5i5AJsFoCrBjVsbEmdaEsLAAg4R"), new PublicKey("7Ui6rheccrpiAU81vw4rHe5UeurAZVKiv82u9dtg6Zys")).then(console.log).catch(console.error);


  console.log(gameAccount)
  for (let i = 0; i <0; i++) {

    const recipient = Keypair.generate().publicKey;

    // Transfer for gameData.mint
    let transaction = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 333333 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })
    );

    const sourceAccount = getAssociatedTokenAddressSync(gameAccount.mint, wallet.publicKey, true, TOKEN_2022_PROGRAM_ID);
    const destinationAccount = getAssociatedTokenAddressSync(gameAccount.mint, recipient, true, TOKEN_2022_PROGRAM_ID);

    if (!(await connection.getAccountInfo(destinationAccount))) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          destinationAccount,
          recipient,
          gameAccount.mint,
          TOKEN_2022_PROGRAM_ID
        )
      );
    }

    const executeInstruction = createExecuteInstruction(
      program.programId,
      sourceAccount,
      gameAccount.mint,
      destinationAccount,
      wallet.publicKey,
      getExtraAccountMetaAddress(gameAccount.mint, program.programId),
      bigIntAmount
    );

    const validateStatePubkey = getExtraAccountMetaAddress(gameAccount.mint, program.programId);
    const validateStateAccount = await connection.getAccountInfo(validateStatePubkey);
    if (validateStateAccount == null) {
        console.log('No validate state account found');
        return;
    }
    const validateStateData = getExtraAccountMetas(validateStateAccount);
let ii = 0;
  for (const extraAccountMeta of validateStateData) {
    console.log(executeInstruction.keys)
    console.log(validateStateData)
    ii++
      executeInstruction.keys.push(
          deEscalateAccountMeta(
              await resolveExtraAccountMeta(
                  connection,
                  extraAccountMeta,
                  executeInstruction.keys,
                  executeInstruction.data,
                  executeInstruction.programId
              ),
              executeInstruction.keys
          )
      );
  }
    const transferInstruction = await createTransferCheckedWithTransferHookInstruction(
      connection,
      sourceAccount,
      gameAccount.mint,
      destinationAccount,
      wallet.publicKey,
      bigIntAmount,
      MintLayout.decode((await connection.getAccountInfo(gameAccount.mint)).data as Buffer).decimals,
      [],
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    transaction.add(transferInstruction);
    
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transaction.feePayer = wallet.publicKey;
    transaction.sign(wallet.payer);
    let txSig = await connection.sendRawTransaction(transaction.serialize());
  const [extra2, b] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), otherMint.publicKey.toBuffer()],
    new PublicKey("AxaViNQ6EwvHuhAXXgsHkjAVXJdRTemYJeJEepaT8zDX"),
  );
    console.log("Transfer Signature for gameData.mint:", txSig);

    await new Promise(resolve => setTimeout(resolve, 3000));
    // Transfer for gameData.otherMint
    transaction = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 333333 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })
    );

    const otherSourceAccount = getAssociatedTokenAddressSync(new PublicKey("5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd"), wallet.publicKey, true, TOKEN_2022_PROGRAM_ID);
    const otherDestinationAccount = getAssociatedTokenAddressSync(new PublicKey("5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd"), recipient, true, TOKEN_2022_PROGRAM_ID);

    if (!(await connection.getAccountInfo(otherDestinationAccount))) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          otherDestinationAccount,
          recipient,
          new PublicKey("5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd"),
          TOKEN_2022_PROGRAM_ID
        )
      );
    }

    const otherTransferInstruction = await createTransferCheckedWithTransferHookInstruction(
      connection,
      otherSourceAccount,
      new PublicKey("5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd"),
      otherDestinationAccount,
      wallet.publicKey,
      bigIntAmount,
      MintLayout.decode((await connection.getAccountInfo(new PublicKey("5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd"))).data as Buffer).decimals,
      [],
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    transaction.add(otherTransferInstruction);

    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transaction.feePayer = wallet.publicKey;
    transaction.sign(wallet.payer);
    txSig = await connection.sendRawTransaction(transaction.serialize());
    console.log("Transfer Signature for gameData.otherMint:", txSig);
    console.log(PublicKey.findProgramAddressSync([
      Buffer.from('extra-account-metas'),
      new PublicKey("5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd").toBuffer()
    ], program.programId)[0].toBase58());
    await new Promise(resolve => setTimeout(resolve, 3000));
   await connection.confirmTransaction(txSig);
  } 

const [extra] = PublicKey.findProgramAddressSync(
  [Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()],
  new PublicKey("AxaViNQ6EwvHuhAXXgsHkjAVXJdRTemYJeJEepaT8zDX"),
);const [extra2, b] = PublicKey.findProgramAddressSync(
  [Buffer.from("extra-account-metas"), otherMint.publicKey.toBuffer()],
  new PublicKey("AxaViNQ6EwvHuhAXXgsHkjAVXJdRTemYJeJEepaT8zDX"),
);
// Add create instruction for game NFT token account if it doesn't exist

 const sig = await provider.sendAndConfirm(new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({microLamports: 333333})).add(ix), [nftMint])
  console.log('sig', sig)
 // console.log(mint.publicKey.toBase58(), new PublicKey("5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd").toBase58())
const tickArrayLower = TickUtils.getTickArrayAddressByTick(
  new PublicKey(poolKeys.programId),
  new PublicKey(pool.id),
  Math.min(lowerTick, upperTick),
  pool.ammConfig.tickSpacing
);

const tickArrayUpper = TickUtils.getTickArrayAddressByTick(
 new PublicKey( poolKeys.programId ),
  new PublicKey(pool.id),
  Math.max(lowerTick, upperTick),
  pool.ammConfig.tickSpacing
);

console.log("Tick Array Lower:", tickArrayLower.toBase58());
console.log("Tick Array Upper:", tickArrayUpper.toBase58());

// Add create instructions for game token accounts if they don't exist
const extraTokenAccount0 = getAssociatedTokenAddressSync(new PublicKey(pool.mintA),extra, true);
const extraTokenAccount1 = getAssociatedTokenAddressSync(new PublicKey(pool.mintB), extra, true);

// Add create instructions for game token accounts if they don't exist
const extraTokenAccount3 = getAssociatedTokenAddressSync(new PublicKey(gameAccount.mint),extra, true, TOKEN_2022_PROGRAM_ID);
const extraTokenAccount4 = getAssociatedTokenAddressSync(new PublicKey(gameAccount.otherMint), extra, true, TOKEN_2022_PROGRAM_ID);
// Initialize First Extra Account Meta List
/*
const initializeFirstExtraAccountMetaListInstruction = await programeco.methods
  .initializeFirstExtraAccountMetaList()
  .accounts({
    payer: wallet.publicKey,
    solanaSaferMewnExtraAccountMetaLis: extra,
    mint: otherMint.publicKey,
    gameOrRay: game,
    nftAccount: getAssociatedTokenAddressSync(nftMint.publicKey, wallet.publicKey, true),
    poolState: new PublicKey(pool.id),
    tokenProgram: TOKEN_PROGRAM_ID,
    tokenAccount0: extraTokenAccount0,
    tokenAccount1: extraTokenAccount1,
    tokenVault0: new PublicKey(pool.vaultA),
    tokenVault1: new PublicKey(pool.vaultB),
    
    positionInfo: new PublicKey("EGAgwPc1xjcyVz1kHFZT29fRdw43CvHXecMFLwUSx6Ki")
  })
  .preInstructions([ComputeBudgetProgram.setComputeUnitPrice({microLamports:333333})])
  .rpc();
  console.log(initializeFirstExtraAccountMetaListInstruction)

// Initialize Second Extra Account Meta List
const initializeSecondExtraAccountMetaListInstruction = await program.methods
  .initializeSecondExtraAccountMetaList()
  .accounts({
    funder: wallet.publicKey,
    mint: mint.publicKey,
    solanaSaferMewn: new PublicKey("5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd"),
    raydiumAmmV3Program: RAYDIUM_PROGRAM_ID,
    nftAccount: getAssociatedTokenAddressSync(nftMint.publicKey, wallet.publicKey, true),
    poolState: new PublicKey(pool.id),
    protocolPosition: getPdaProtocolPositionAddress(RAYDIUM_PROGRAM_ID, new PublicKey(pool.id), lowerTick, upperTick).publicKey,
    personalPosition: getPdaPersonalPositionAddress(RAYDIUM_PROGRAM_ID, nftMint.publicKey).publicKey,
    tokenAccount0: tokenAccountA.address,
    tokenAccount1: tokenAccountB.address,
    tokenVault0: new PublicKey(pool.vaultA),
    tokenVault1: new PublicKey(pool.vaultB),
    tickArrayLower,
  })
  .instruction();
*/
//7kcG34bLzenp1hdCUo2HDPvHxTQSM95VsU6jSAyDajTT 7kcG34bLzenp1hdCUo2HDPvHxTQSM95VsU6jSAyDajTT
// Create ProxyOpenPosition instruction
const preixs: any = []

// Get account info for user ATA for mint.publicKey
const userAtaMint = getAssociatedTokenAddressSync(mint.publicKey, wallet.publicKey, true, TOKEN_2022_PROGRAM_ID);
let userAtaMintInfo = await connection.getAccountInfo(userAtaMint);

let extraTokenAccount0Info2 = await connection.getAccountInfo(extraTokenAccount3);
if (extraTokenAccount0Info2 === null) {
  preixs.push(
    createAssociatedTokenAccountInstruction(
      wallet.publicKey,
      extraTokenAccount3,
      extra,
     new PublicKey( gameAccount.mint), TOKEN_2022_PROGRAM_ID
    )
  );
}

let extraTokenAccount1Info4 = await connection.getAccountInfo(extraTokenAccount4);
if (extraTokenAccount1Info4 === null) {
  preixs.push(
    createAssociatedTokenAccountInstruction(
      wallet.publicKey,
      extraTokenAccount4,
      extra,
      new PublicKey( gameAccount.otherMint), TOKEN_2022_PROGRAM_ID
    )
  );
}


// Add create instruction if user ATA for mint.publicKey doesn't exist
if (userAtaMintInfo == undefined) {
  preixs.push(
    createAssociatedTokenAccountInstruction(
      wallet.publicKey,
      userAtaMint,
      wallet.publicKey,
      mint.publicKey,
      TOKEN_2022_PROGRAM_ID
    )
  );
}
let extraTokenAccount0Info = await connection.getAccountInfo(extraTokenAccount0);
if (extraTokenAccount0Info === null) {
  preixs.push(
    createAssociatedTokenAccountInstruction(
      wallet.publicKey,
      extraTokenAccount0,
      extra,
      new PublicKey(pool.mintA)
    )
  );
}

let extraTokenAccount1Info = await connection.getAccountInfo(extraTokenAccount1);
if (extraTokenAccount1Info === null) {
  preixs.push(
    createAssociatedTokenAccountInstruction(
      wallet.publicKey,
      extraTokenAccount1,
      extra,
      new PublicKey(pool.mintB)
    )
  );
}

// Get account info for user ATA for new PublicKey("5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd")
const userAtaOtherMint = getAssociatedTokenAddressSync(new PublicKey("5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd"), wallet.publicKey, true, TOKEN_2022_PROGRAM_ID);
let userAtaOtherMintInfo = await connection.getAccountInfo(userAtaOtherMint);

// Add create instruction if user ATA for new PublicKey("5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd") doesn't exist
if (userAtaOtherMintInfo == undefined) {
  preixs.push(
    createAssociatedTokenAccountInstruction(
      wallet.publicKey,
      userAtaOtherMint,
      wallet.publicKey,
      new PublicKey("5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd"),
      TOKEN_2022_PROGRAM_ID
    )
  );
}
const nftttt = Keypair.generate()//getAssociatedTokenAddressSync(otherMint.publicKey, extra2, true, TOKEN_2022_PROGRAM_ID)
let todo = TickUtils.getTickArrayStartIndexByTick(Math.min(lowerTick, upperTick), pool.ammConfig.tickSpacing)
let pos = todo > 0
todo = Math.abs(todo)
const [positionInfo] = PublicKey.findProgramAddressSync([
  Buffer.from(pos ? new BN(todo).toBuffer('le', 4) : new BN(-1 * todo).toBuffer('le', 4)),
], program.programId)
console.log(todo.toString(), pos)
const proxyOpenPositionInstruction = await program.methods
  .openPosition(
  )
  .accounts({
    safe:PublicKey.findProgramAddressSync([
      Buffer.from('extra-account-metas'),
      gameAccount.mint.toBuffer()
    ], program.programId)[0],
    extraTokenAccount0:getAssociatedTokenAddressSync(new PublicKey(pool.mintA), extra, true),
    extraTokenAccount1:getAssociatedTokenAddressSync(new PublicKey(pool.mintB), extra, true),
    funder: wallet.publicKey,
    positionNftMint: nftMint.publicKey,
    positionNftAccount: getAssociatedTokenAddressSync(nftMint.publicKey, wallet.publicKey, true),
    extraNftTokenAccount: nftttt.publicKey,// getAssociatedTokenAddressSync(nftMint.publicKey, extra, true),
    poolState: new PublicKey(pool.id),
    protocolPosition: getPdaProtocolPositionAddress(RAYDIUM_PROGRAM_ID, new PublicKey(pool.id), lowerTick, upperTick).publicKey,
    personalPosition: getPdaPersonalPositionAddress(RAYDIUM_PROGRAM_ID, nftMint.publicKey).publicKey,
    tokenVault0: new PublicKey(pool.vaultA),
    tokenVault1: new PublicKey(pool.vaultB),
    userAta: userAtaMint,
    mint: mint.publicKey,
    mint2: gameAccount.otherMint,
    userAta2:  getAssociatedTokenAddressSync(gameAccount.otherMint, wallet.publicKey, true, TOKEN_2022_PROGRAM_ID),

  })
  .instruction();
  await new Promise(resolve => setTimeout(resolve, 3000));

console.log(proxyOpenPositionInstruction);
// Create and send transaction for initializing Extra Account Meta Lists
const initMetaListsTransaction = new Transaction()
//.add(...preixs)
 .add(ComputeBudgetProgram.setComputeUnitPrice({microLamports: 333333}))

//.add(udpateArb2)/*.add( /*createInitializeInstruction({
  /*programId: TOKEN_2022_PROGRAM_ID,
  mint: new PublicKey("5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd"),
  metadata:  new PublicKey("5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd"),
  name: "Flywheel",
  symbol: "FLY",
  uri: "https://tinyurl.com/3dwayjzb",
  mintAuthority: wallet.publicKey,
  updateAuthority: wallet.publicKey,
}))*/
 // .add(udpateArb2)
//  .add(udpateArb2)
.add(proxyOpenPositionInstruction)
 //.add(initializeSecondExtraAccountMetaListInstruction)
//  .add(initializeSecondExtraAccountMetaListInstruction);

try {
  const initMetaListsSignature = await sendAndConfirmTransaction(
    connection,
    initMetaListsTransaction,
    [wallet.payer, nftMint, nftttt],{skipPreflight: true}
  );
  console.log("Extra Account Meta Lists initialized. Transaction signature:", initMetaListsSignature);
} catch (error) {
  console.error("Failed to initialize Extra Account Meta Lists:", error);
  console.log("Extra Account Meta Lists initialization failed");
//}initSplashPoolWithTransferHook(mint.publicKey, NATIVE_MINT,new PublicKey("D7J87aVoqfG1UMVMj6TQG6XWLtbMZ7VHiuaiBYudPB4K"), new PublicKey("BtJghMidPMjUKqF2vDXofQPXA8BRu3Q4PdnFSJP7pLPt"))
}
 //  initSplashPoolWithTransferHook(gameAccount.mint, new PublicKey("GGo8ee2DkuX2oFminYuBphMwEiQ5BdCzyYd84Nnm24R5"),new PublicKey("75nA3pTtVRi2UbQaQQjDTJgYx9T8gUSjhxW4TapW4HjA"), new PublicKey("8hdTW4eVCHC2hJ29kf1HkU6MiBR6XsZ1ryi4VrjGg32F"))
   // await  initSplashPoolWithTransferHook(new PublicKey("5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd"), new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), new PublicKey("75nA3pTtVRi2UbQaQQjDTJgYx9T8gUSjhxW4TapW4HjA"), new PublicKey("8hdTW4eVCHC2hJ29kf1HkU6MiBR6XsZ1ryi4VrjGg32F"));

  return {
    poolId: pool.id,
    baseMint: baseMint.address.toBase58(),
    quoteMint: quoteMint.address.toBase58(),
    baseAmount,
    quoteAmount
  };
}

async function getOrCreateAssociatedTokenAccount(connection: Connection, payer: Keypair, mint: PublicKey, owner: PublicKey) {

  const ai = await connection.getAccountInfo(mint)
  const associatedTokenAddress = getAssociatedTokenAddressSync(mint, owner, true, ai.owner);
  
  try {
    await connection.getTokenAccountBalance(associatedTokenAddress);

  } catch (error) {
    // If the account doesn't exist, create it
    const transaction = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({microLamports: 333333}),
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        associatedTokenAddress,
        owner,
        mint,
        ai.owner
      )
    );
    await sendAndConfirmTransaction(connection, transaction, [payer]);
  }
  return {address:associatedTokenAddress, ai: await connection.getAccountInfo(associatedTokenAddress)};
}

// Usage
const mintA = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // Example: USDC
initRaydiumPool(mintA, new PublicKey("BQpGv6LVWG1JRm1NdjerNSFdChMdAULJr3x9t2Swpump")).then(console.log).catch(console.error);