import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LendingPool } from "../target/types/lending_pool";
import {
    Connection,
    Keypair,
    SystemProgram,
    Transaction,
    clusterApiUrl,
    sendAndConfirmTransaction,
    LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
    ExtensionType,
    updateRateInterestBearingMint,
    createInitializeInterestBearingMintInstruction,
    createInitializeMintInstruction,
    getMintLen,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    amountToUiAmount,
    getInterestBearingMintConfigState,
    getMint,
    createAssociatedTokenAccount,
    getAssociatedTokenAddressSync,
} from "@solana/spl-token";

function logTransactionSignature(transactionSignature: string) {
    const cluster = "custom&customUrl=http%3A%2F%2Flocalhost%3A8899";

    console.log(
        "\nCreate Mint Account:",
        `https://explorer.solana.com/tx/${transactionSignature}?cluster=${cluster}`,
    );
}

describe("lending-pool", () => {
    // Configure the client to use the local cluster.
    anchor.setProvider(anchor.AnchorProvider.env());
    const provider = anchor.AnchorProvider.env();
    const program = anchor.workspace.LendingPool as Program<LendingPool>;
    const connection = provider.connection;
    const payer = provider.wallet as anchor.Wallet;

    // Generate new keypair for Mint Account
    const mintKeypair = Keypair.generate();
    // Address for Mint Account
    const mint = mintKeypair.publicKey;
    // Decimals for Mint Account
    const decimals = 9;
    // Authority that can mint new tokens
    const mintAuthority = provider.wallet as anchor.Wallet;
    // Authority that can update the interest rate
    const rateAuthority = provider.wallet;
    // Interest rate basis points (100 = 1%)
    // Max value = 32,767 (i16)
    const rate = 0;

    // Size of Mint Account with extension
    const mintLen = getMintLen([ExtensionType.InterestBearingConfig]);

    // Generate new keypairs for HolderA and HolderB
    const holderA = Keypair.generate();
    const holderB = Keypair.generate();
    const holderAATA = getAssociatedTokenAddressSync(
        mint, // Mint address
        holderA.publicKey, // Owner's public key
        false, // Allow owner off curve (default: false)
        TOKEN_2022_PROGRAM_ID // Token program ID
    );
    const holderBATA = getAssociatedTokenAddressSync(
        mint, // Mint address
        holderB.publicKey, // Owner's public key
        false, // Allow owner off curve (default: false)
        TOKEN_2022_PROGRAM_ID // Token program ID
    );

    // Derive the pool PDA using "pool" as the seed
    const [poolPda, _poolBump] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("pool")],
        program.programId
    );

    // Print all public keys generated above
    console.log("HolderA ATA:", holderAATA.toBase58());
    console.log("HolderB ATA:", holderBATA.toBase58());
    console.log("Mint:", mint.toBase58());
    console.log("HolderA:", holderA.publicKey.toBase58());
    console.log("HolderB:", holderB.publicKey.toBase58());
    console.log("Mint Authority:", mintAuthority.publicKey.toBase58());
    console.log("Rate Authority:", rateAuthority.publicKey.toBase58());
    console.log("Payer:", payer.publicKey.toBase58());
    console.log("System Program:", SystemProgram.programId.toBase58());
    console.log("Token Program:", TOKEN_2022_PROGRAM_ID.toBase58());
    console.log("Associated Token Program:", ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
    console.log("Lending Pool Program:", program.programId.toBase58());
    console.log("Pool PDA:", poolPda.toBase58());

    it("Airdrops SOL to HolderA and HolderB", async () => {
        const rentExemptionForSystemAccount = await connection.getMinimumBalanceForRentExemption(0);
        const rentExemptionForTokenAccount = await connection.getMinimumBalanceForRentExemption(mintLen);

        const totalAirdropHolderA = 2 * LAMPORTS_PER_SOL + rentExemptionForSystemAccount + rentExemptionForTokenAccount;
        const totalAirdropHolderB = 3 * LAMPORTS_PER_SOL + rentExemptionForSystemAccount + rentExemptionForTokenAccount;

        await connection.requestAirdrop(holderA.publicKey, totalAirdropHolderA); // 2 SOL + rent exemption
        await connection.requestAirdrop(holderB.publicKey, totalAirdropHolderB); // 3 SOL + rent exemption
    });

    it("Creates a token Mint account with Interest Bearing extension", async () =>{

        // Minimum lamports required for Mint Account
        const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

        // Instruction to invoke System Program to create new account
        const createAccountInstruction = SystemProgram.createAccount({
            fromPubkey: payer.publicKey, // Account that will transfer lamports to created account
            newAccountPubkey: mint, // Address of the account to create
            space: mintLen, // Amount of bytes to allocate to the created account
            lamports, // Amount of lamports transferred to created account
            programId: TOKEN_2022_PROGRAM_ID, // Program assigned as owner of created account
        });

        // Instruction to initialize the InterestBearingConfig Extension
        const initializeInterestBearingMintInstruction =
            createInitializeInterestBearingMintInstruction(
                mint, // Mint Account address
                rateAuthority.publicKey, // Designated Rate Authority
                rate, // Interest rate basis points
                TOKEN_2022_PROGRAM_ID, // Token Extension Program ID
            );

        // Instruction to initialize Mint Account data
        const initializeMintInstruction = createInitializeMintInstruction(
            mint, // Mint Account Address
            decimals, // Decimals of Mint
            mintAuthority.publicKey, // Designated Mint Authority
            null, // Optional Freeze Authority
            TOKEN_2022_PROGRAM_ID, // Token Extension Program ID
        );

        // Add instructions to new transaction
        const transaction = new Transaction().add(
            createAccountInstruction,
            initializeInterestBearingMintInstruction,
            initializeMintInstruction,
        );

        // Send transaction
        const transactionSignature = await sendAndConfirmTransaction(
            connection,
            transaction,
            [payer.payer, mintKeypair], // Signers
        );

        logTransactionSignature(transactionSignature);

    });

    it("Pool is initialized!", async () => {
        const tx = await program.methods.initialize()
            .accounts({
                payer: provider.wallet.publicKey,
            })
            .signers([payer.payer])
            .rpc();

        logTransactionSignature(tx);
    });

    it("Registers depositors", async () => {
        const tx1 = await program.methods.registerDepositor()
            .accountsStrict({
                depositor: holderA.publicKey,
                mint: mint,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                depositorAta: holderAATA,
            })
            .signers([holderA])
            .rpc();
        logTransactionSignature(tx1);

        const tx2 = await program.methods.registerDepositor()
            .accountsStrict({
                depositor: holderB.publicKey,
                mint: mint,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                depositorAta: holderBATA,
            })
            .signers([holderB])
            .rpc();

        logTransactionSignature(tx2);
    });

    it("Deposits SOL and mints iSOL tokens", async () => {

        // Deposit SOL into the lending pool and mint iSOL tokens
        // This part will depend on your lending pool program's implementation
        // Assuming you have a deposit method in your program
        await program.methods.deposit(new anchor.BN(2 * LAMPORTS_PER_SOL)) // 2 SOL
            .accountsStrict({
                depositor: holderA.publicKey,
                mint: mint,
                mintAuthority: mintAuthority.publicKey, // Your mint authority public key
                depositorAta: holderAATA,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                poolPda: poolPda,
            })
            .signers([holderA, mintAuthority.payer])
            .rpc();

        await program.methods.deposit(new anchor.BN(3 * LAMPORTS_PER_SOL)) // 3 SOL
            .accountsStrict({
                depositor: holderB.publicKey,
                mint: mint,
                mintAuthority: mintAuthority.publicKey, // Your mint authority public key
                depositorAta: holderBATA,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_2022_PROGRAM_ID, 
                poolPda: poolPda,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            })
            .signers([holderB, mintAuthority.payer])
            .rpc();

        // Check balances of iSOL tokens in HolderA and HolderB's ATAs
        const holderA_iSolBalance = await connection.getTokenAccountBalance(holderAATA);
        const holderB_iSolBalance = await connection.getTokenAccountBalance(holderBATA);

        const holderA_iSolBalanceInSOL = holderA_iSolBalance.value.uiAmount;
        const holderB_iSolBalanceInSOL = holderB_iSolBalance.value.uiAmount;

        // Convert amount to UI amount with accrued interest
        const holderA_AccruedValueAmount = await amountToUiAmount(
            connection, // Connection to the Solana cluster
            payer.payer, // Account that will transfer lamports for the transaction
            mint, // Address of the Mint account
            BigInt(holderA_iSolBalance.value.amount), // Amount to be converted
            TOKEN_2022_PROGRAM_ID, // Token Extension Program ID
        );
        const holderB_AccruedValueAmount = await amountToUiAmount(
            connection, // Connection to the Solana cluster
            payer.payer, // Account that will transfer lamports for the transaction
            mint, // Address of the Mint account
            BigInt(holderB_iSolBalance.value.amount), // Amount to be converted
            TOKEN_2022_PROGRAM_ID, // Token Extension Program ID
        );

        console.log(`HolderA Balance: ${holderA_iSolBalanceInSOL} iSOL = ${holderA_AccruedValueAmount} SOL`);
        console.log(`HolderB Balance: ${holderB_iSolBalanceInSOL} iSOL = ${holderB_AccruedValueAmount} SOL`);
    });
});