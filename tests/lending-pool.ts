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
    mintTo,
    getOrCreateAssociatedTokenAccount,
    createSetAuthorityInstruction,
    AuthorityType
} from "@solana/spl-token";
import { expect } from "chai";

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
    const iSolMintKeypair = Keypair.generate();
    const iSolMint = iSolMintKeypair.publicKey;
    // Decimals for Mint Account
    const iSolDecimals = 9;
    // Authority that can mint new tokens
    let iSolMintAuthority = (provider.wallet as anchor.Wallet).publicKey;
    // Authority that can update the interest rate
    const iSolRateAuthority = provider.wallet;
    // Interest rate basis points (100 = 1%)
    // Max value = 32,767 (i16)
    const iSolRate = 0;
    // Size of Mint Account with extension
    const iSolMintLen = getMintLen([ExtensionType.InterestBearingConfig]);

    // Generate new keypair for USDC Mint Account
    const usdcMintKeypair = Keypair.generate();
    const usdcMint = usdcMintKeypair.publicKey;
    const usdcDecimals = 6; // USDC typically has 6 decimals
    const usdcMintAuthority = provider.wallet as anchor.Wallet;
    const usdcMintLen = getMintLen([]); // Assuming USDC mint has no extensions


    // Generate new keypairs for HolderA and HolderB
    const holderA = Keypair.generate();
    const holderB = Keypair.generate();
    const holderAATA = getAssociatedTokenAddressSync(
        iSolMint, // Mint address
        holderA.publicKey, // Owner's public key
        false, // Allow owner off curve (default: false)
        TOKEN_2022_PROGRAM_ID // Token program ID
    );
    const holderBATA = getAssociatedTokenAddressSync(
        iSolMint, // Mint address
        holderB.publicKey, // Owner's public key
        false, // Allow owner off curve (default: false)
        TOKEN_2022_PROGRAM_ID // Token program ID
    );

    // Generate new keypair for BorrowerA
    const borrowerA = Keypair.generate();
    const borrowerAATA = getAssociatedTokenAddressSync(
        usdcMint, // Mint address
        borrowerA.publicKey, // Owner's public key
        false, // Allow owner off curve (default: false)
        TOKEN_2022_PROGRAM_ID // Token program ID
    );

    // Derive the pool PDA using "pool" as the seed
    const [poolPda, _poolBump] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("pool")],
        program.programId
    );

    // Derive the PDA address for the collateral_ta_pda
    const [collateralTaPda, _] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("collateral")],
        program.programId
    );

    // Derive the PDA for the iSOL Mint authority
    const [pda_iSolMintAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("isol_mint_auth")],
        program.programId
    );

    // Print all public keys generated above
    console.log("HolderA ATA:", holderAATA.toBase58());
    console.log("HolderB ATA:", holderBATA.toBase58());
    console.log("BorrowerA ATA:", borrowerAATA.toBase58());
    console.log("HolderA:", holderA.publicKey.toBase58());
    console.log("HolderB:", holderB.publicKey.toBase58());
    console.log("BorrowerA:", borrowerA.publicKey.toBase58());
    console.log("iSol Mint:", iSolMint.toBase58());
    console.log("iSol Mint Authority BEFORE init:", iSolMintAuthority.toBase58());
    console.log("iSol Mint Authority AFTER init:", pda_iSolMintAuthority.toBase58());
    console.log("Rate Authority:", iSolRateAuthority.publicKey.toBase58());
    console.log("Payer:", payer.publicKey.toBase58());
    console.log("System Program:", SystemProgram.programId.toBase58());
    console.log("Token Program:", TOKEN_2022_PROGRAM_ID.toBase58());
    console.log("Associated Token Program:", ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
    console.log("Lending Pool Program:", program.programId.toBase58());
    console.log("Pool PDA:", poolPda.toBase58());
    console.log("USDC Mint:", usdcMint.toBase58());
    console.log("USDC Mint Authority:", usdcMintAuthority.publicKey.toBase58());

    it("Creates a dummy USDC Mint account", async () => {

        // Minimum lamports required for USDC Mint Account
        const usdcLamports = await connection.getMinimumBalanceForRentExemption(usdcMintLen);

        // Instruction to invoke System Program to create new account
        const createUsdcAccountInstruction = SystemProgram.createAccount({
            fromPubkey: payer.publicKey, // Account that will transfer lamports to created account
            newAccountPubkey: usdcMint, // Address of the account to create
            space: usdcMintLen, // Amount of bytes to allocate to the created account
            lamports: usdcLamports, // Amount of lamports transferred to created account
            programId: TOKEN_2022_PROGRAM_ID, // Program assigned as owner of created account
        });

        // Instruction to initialize Mint Account data
        const initializeUsdcMintInstruction = createInitializeMintInstruction(
            usdcMint, // Mint Account Address
            usdcDecimals, // Decimals of Mint
            usdcMintAuthority.publicKey, // Designated Mint Authority
            null, // Optional Freeze Authority
            TOKEN_2022_PROGRAM_ID, // Token Extension Program ID
        );

        // Add instructions to new transaction
        const usdcTransaction = new Transaction().add(
            createUsdcAccountInstruction,
            initializeUsdcMintInstruction,
        );

        // Send transaction
        const usdcTransactionSignature = await sendAndConfirmTransaction(
            connection,
            usdcTransaction,
            [payer.payer, usdcMintKeypair], // Signers
        );

        logTransactionSignature(usdcTransactionSignature);

        // Create a new throw-away ATA for testing
        const throwAwayATA = await createAssociatedTokenAccount(
            connection,
            payer.payer,
            usdcMint,
            payer.publicKey,
            {
                commitment: "confirmed",
            },
            TOKEN_2022_PROGRAM_ID,
        );

        // Mint 10 USDC to the throw-away ATA
        const mintAmount = 10 * 10 ** usdcDecimals;
        await mintTo(
            connection,
            payer.payer,
            usdcMint,
            throwAwayATA,
            usdcMintAuthority.publicKey,
            mintAmount,
            [],
            {
                commitment: "confirmed",
            },
            TOKEN_2022_PROGRAM_ID,
        );

        // Check the balance of the throw-away ATA
        const throwAwayATABalance = await connection.getTokenAccountBalance(throwAwayATA);
        console.log(`Throw-away ATA Balance: ${throwAwayATABalance.value.uiAmount} USDC`);
    });

    it("Airdrops SOL to HolderA and HolderB", async () => {
        const rentExemptionForSystemAccount = await connection.getMinimumBalanceForRentExemption(0);
        const rentExemptionForTokenAccount = await connection.getMinimumBalanceForRentExemption(iSolMintLen);

        const totalAirdropHolderA = 2 * LAMPORTS_PER_SOL + rentExemptionForSystemAccount + rentExemptionForTokenAccount;
        const totalAirdropHolderB = 3 * LAMPORTS_PER_SOL + rentExemptionForSystemAccount + rentExemptionForTokenAccount;

        await connection.requestAirdrop(holderA.publicKey, totalAirdropHolderA); // 2 SOL + rent exemption
        await connection.requestAirdrop(holderB.publicKey, totalAirdropHolderB); // 3 SOL + rent exemption
    });

    it("Creates a token Mint account with Interest Bearing extension", async () => {

        // Minimum lamports required for Mint Account
        const lamports = await connection.getMinimumBalanceForRentExemption(iSolMintLen);

        // Instruction to invoke System Program to create new account
        const createAccountInstruction = SystemProgram.createAccount({
            fromPubkey: payer.publicKey, // Account that will transfer lamports to created account
            newAccountPubkey: iSolMint, // Address of the account to create
            space: iSolMintLen, // Amount of bytes to allocate to the created account
            lamports, // Amount of lamports transferred to created account
            programId: TOKEN_2022_PROGRAM_ID, // Program assigned as owner of created account
        });

        // Instruction to initialize the InterestBearingConfig Extension
        const initializeInterestBearingMintInstruction =
            createInitializeInterestBearingMintInstruction(
                iSolMint, // Mint Account address
                iSolRateAuthority.publicKey, // Designated Rate Authority
                iSolRate, // Interest rate basis points
                TOKEN_2022_PROGRAM_ID, // Token Extension Program ID
            );

        // Instruction to initialize Mint Account data
        const initializeMintInstruction = createInitializeMintInstruction(
            iSolMint, // Mint Account Address
            iSolDecimals, // Decimals of Mint
            iSolMintAuthority, // Designated Mint Authority
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
            [payer.payer, iSolMintKeypair], // Signers
        );

        logTransactionSignature(transactionSignature);
    });

    it("Lending Program is initialized!", async () => {
        const tx = await program.methods.initialize()
            .accounts({
                payer: provider.wallet.publicKey,
                collateralMint: usdcMint,
            })
            .signers([payer.payer])
            .rpc();

        logTransactionSignature(tx);

        // Transfer authority to PDA.
        // Add instruction to new transaction
        const setAuthorityTransaction = new Transaction().add(
            createSetAuthorityInstruction(
                iSolMint,
                iSolMintAuthority,
                AuthorityType.MintTokens,
                pda_iSolMintAuthority,
                [],
                TOKEN_2022_PROGRAM_ID
            ),
            createSetAuthorityInstruction(
                iSolMint,
                iSolMintAuthority,
                AuthorityType.InterestRate,
                pda_iSolMintAuthority,
                [],
                TOKEN_2022_PROGRAM_ID
            )
        );

        // Send transaction
        const setAuthoritySignature = await sendAndConfirmTransaction(
            connection,
            setAuthorityTransaction,
            [payer.payer],
        );

        logTransactionSignature(setAuthoritySignature);

        iSolMintAuthority = pda_iSolMintAuthority;
        console.log(`iSOL Mint authority set to PDA: ${iSolMintAuthority.toBase58()}`);
    });

    it("Registers depositors", async () => {
        const tx1 = await program.methods.registerDepositor()
            .accountsStrict({
                depositor: holderA.publicKey,
                mint: iSolMint,
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
                mint: iSolMint,
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
                isolMint: iSolMint,
                isolMintAuthority: iSolMintAuthority,
                depositorAta: holderAATA,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                poolPda: poolPda,
            })
            .signers([holderA])
            .rpc();

        await program.methods.deposit(new anchor.BN(3 * LAMPORTS_PER_SOL)) // 3 SOL
            .accountsStrict({
                depositor: holderB.publicKey,
                isolMint: iSolMint,
                isolMintAuthority: iSolMintAuthority,
                depositorAta: holderBATA,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
                poolPda: poolPda,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            })
            .signers([holderB])
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
            iSolMint, // Address of the Mint account
            BigInt(holderA_iSolBalance.value.amount), // Amount to be converted
            TOKEN_2022_PROGRAM_ID, // Token Extension Program ID
        );
        const holderB_AccruedValueAmount = await amountToUiAmount(
            connection, // Connection to the Solana cluster
            payer.payer, // Account that will transfer lamports for the transaction
            iSolMint, // Address of the Mint account
            BigInt(holderB_iSolBalance.value.amount), // Amount to be converted
            TOKEN_2022_PROGRAM_ID, // Token Extension Program ID
        );

        console.log(`HolderA Balance: ${holderA_iSolBalanceInSOL} iSOL = ${holderA_AccruedValueAmount} SOL`);
        console.log(`HolderB Balance: ${holderB_iSolBalanceInSOL} iSOL = ${holderB_AccruedValueAmount} SOL`);
    });

    it("BorrowerA borrows SOL using USDC as collateral", async () => {
        const rentExemptionForSystemAccount = await connection.getMinimumBalanceForRentExemption(0);
        const rentExemptionForTokenAccount = await connection.getMinimumBalanceForRentExemption(usdcMintLen);

        const totalAirdropBorrowerA = rentExemptionForSystemAccount + rentExemptionForTokenAccount;

        // Airdrop SOL to BorrowerA for transaction fees and rent exemption
        console.log("Funding BorrowerA with rent-exemption SOL...");
        await connection.requestAirdrop(borrowerA.publicKey, totalAirdropBorrowerA);

        // Create BorrowerA's ATA for USDC
        console.log("Creating BorrowerA's ATA for USDC...");
        await createAssociatedTokenAccount(
            connection,
            payer.payer,
            usdcMint,
            borrowerA.publicKey,
            {
                commitment: "confirmed",
            },
            TOKEN_2022_PROGRAM_ID,
        );

        // Mint 2000 USDC to BorrowerA's ATA
        const totalUSDC = 2000 * 10 ** usdcDecimals;
        await mintTo(
            connection,
            payer.payer,
            usdcMint,
            borrowerAATA,
            usdcMintAuthority.publicKey,
            totalUSDC,
            [],
            {
                commitment: "confirmed",
            },
            TOKEN_2022_PROGRAM_ID,
        )

        // Borrow 2 SOL
        const borrowAmount = new anchor.BN(2.5 * LAMPORTS_PER_SOL); // 2 SOL
        const borrowTx = await program.methods.borrow(borrowAmount)
            .accountsStrict({
                borrower: borrowerA.publicKey,
                borrowerAta: borrowerAATA,
                collateralMint: usdcMint,
                collateralPoolPda: collateralTaPda,
                poolPda: poolPda,
                isolMint: iSolMint,
                isolMintAuthority: iSolMintAuthority,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            })
            .signers([borrowerA])
            .rpc({ commitment: "confirmed" });

        logTransactionSignature(borrowTx);

        // The borrowing interest rate has now increased.
        const mintInfo = await getMint(
            connection,
            iSolMint,
            "confirmed",
            TOKEN_2022_PROGRAM_ID
        );
        
        const interestBearingConfig = await getInterestBearingMintConfigState(
            mintInfo,
        );
        
        if (interestBearingConfig) {
            const RATE_DECIMALS = 100;
            const currentRate = interestBearingConfig.currentRate;
            expect(currentRate / RATE_DECIMALS).equals(50, "Half-utilization rate.");
            console.log(`Current interest rate: ${currentRate} basis points`);
        } else {
            throw new Error("InterestBearingConfig not found on iSOL mint");
        }
    });
});