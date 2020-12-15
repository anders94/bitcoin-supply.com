module.exports = {
    blockLoss: (block) => {
	return false;
    },
    outputLoss: (output) => {
	if (output.script_asm.startsWith('OP_RETURN ')) { // OP_RETURN losses
	    return true;
	}
	else if (output.script_hex == '76a90088ac') { // MtGox error
	    return true;
	}
	else {
	    return false;
	}
    }
}
