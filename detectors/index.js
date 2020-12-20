module.exports = {
    blockLoss: (block) => {
	// Proposal 002 - Miner Loss (TODO)
        if (block.allowed_supply != block.new_supply)
	    return true;
	else
	    return false;
    },
    outputLoss: (block, transaction, output) => {
	// Proposal 000 - Block 0 Coinbase
	if (block.block_number == 0) {
	    return true;
	}
	// Proposal 001 - Conflicting Coinbase Transaction IDs
	else if (block.block_number == 91722 || block.block_number == 91812) {
	    if (transaction.hash == 'e3bf3d07d4b0375638d5f1db5255fe07ba2c4cb067cd81b84ee974b6585fb468' ||
		transaction.hash == 'd5d27987d2a3dfc724e359870c6644b40e497bdc0589a033220fe15429d88599') {
		return true;
	    }
	}
	// Proposal 003 - MtGox Error
	else if (output.script_hex == '76a90088ac') { // MtGox error
	    return true;
	}
	// Proposal 004 - OP_RETURN
	else if (output.script_asm.startsWith('OP_RETURN ')) { // OP_RETURN losses
	    return true;
	}
	return false;
    }
}
