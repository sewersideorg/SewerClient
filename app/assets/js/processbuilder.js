const AdmZip                = require('adm-zip')
const child_process         = require('child_process')
const crypto                = require('crypto')
const fs                    = require('fs-extra')
const os                    = require('os')
const path                  = require('path')
const { URL }               = require('url')

const { Util, Library }        = require('./assetguard')
const ConfigManager            = require('./configmanager')
const DistroManager            = require('./distromanager')
const LoggerUtil               = require('./loggerutil')

const logger = LoggerUtil('%c[ProcessBuilder]', 'color: #003996; font-weight: bold')

class ProcessBuilder {

    constructor(distroServer, versionData, forgeData, authUser, launcherVersion){
        this.gameDir = path.join(ConfigManager.getInstanceDirectory(), ConfigManager.getSelectedServer())
        this.commonDir = ConfigManager.getCommonDirectory()
        this.modDir = path.join(this.commonDir, 'modstore', distroServer.getID())
        this.mcDir = path.join(ConfigManager.getDataDirectory(), 'minecraft')
        this.server = distroServer
        this.versionData = versionData
        this.forgeData = forgeData
        this.authUser = authUser
        this.launcherVersion = launcherVersion
        this.forgeModListFile = path.join(this.gameDir, 'ModList.txt') // 1.13+
        this.fmlDir = path.join(this.gameDir, 'forgeModList.json')
        this.libPath = path.join(this.commonDir, 'libraries')

        this.usingLiteLoader = false
        this.llPath = null
    }
    
    /**
     * Convienence method to run the functions typically used to build a process.
     */
    build(){
        fs.ensureDirSync(this.gameDir)
        fs.ensureDirSync(this.mcDir)

        this.createSymlinks()

        const tempNativePath = path.join(os.tmpdir(), ConfigManager.getTempNativeFolder(), crypto.pseudoRandomBytes(16).toString('hex'))
        process.throwDeprecation = true

        let args = this.constructJVMArguments(tempNativePath, this.server.getModules())

        const child = child_process.spawn(Util.mcVersionAtLeast("1.16", this.server.getMinecraftVersion()) ? ConfigManager.getJava17Executable(): ConfigManager.getJava8Executable(), args, {
            cwd: this.gameDir,
            detached: ConfigManager.getLaunchDetached()
        })

        if(ConfigManager.getLaunchDetached()){
            child.unref()
        }

        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')

        const loggerMCstdout = LoggerUtil('%c[Minecraft]', 'color: #36b030; font-weight: bold')
        const loggerMCstderr = LoggerUtil('%c[Minecraft]', 'color: #b03030; font-weight: bold')

        child.stdout.on('data', (data) => {
            loggerMCstdout.log(data)
        })
        child.stderr.on('data', (data) => {
            loggerMCstderr.log(data)
        })
        child.on('close', (code, signal) => {
            if(ConfigManager.getMinimizeOnLaunch()){
                remote.getCurrentWindow().restore()
            }
            logger.log('Exited with code', code)
            fs.remove(tempNativePath, (err) => {
                if(err){
                    logger.warn('Error while deleting temp dir', err)
                } else {
                    logger.log('Temp dir deleted successfully.')
                    showLaunchFailure('Game Closed','We hope you enjoyed!')
                }
            })
            if(!ConfigManager.getKeepMods()){
                fs.remove(this.modDir, (err) => {
                    if(err){
                    logger.warn('Error while deleting stored mods to allow for constant updating')
                    } else {
                    logger.log('Stored mods were removed successfully')
                    }
                })
            }
        })

        return child
    }

    /**
     * creates symlinks for often-used folders for all Instances
     */
    createSymlinks(){
        this._createSymLinks('resourcepacks', 'dir')
        this._createSymLinks('config', 'dir')
        this._createSymLinks('saves', 'dir')
        this._createSymLinks('servers.dat')
        this._createSymLinks('shaderpacks', 'dir')
    }

    /**
     * creates the symlinks
     */
    _createSymLinks(folder, type = 'file'){
        if (fs.existsSync(path.join(this.gameDir, folder))) {
            logger.log('Won\'t create', folder,  'symlink because the folder/symlink already exists!')
        } else {

            if (type == 'dir'){
                fs.ensureDirSync(path.join(this.mcDir, folder))
            }

            fs.symlink(path.join(this.mcDir, folder), path.join(this.gameDir, folder), type, (err) => {
                if (err){
                    logger.warn('Failed to create', folder, 'symlink!')
                } else {
                    logger.log('Successfully created symlink for the', folder, 'folder!')
                }
            })
        }
    }

    /**
     * resolves a full mod path from just the name
     *
     * @returns {String} pth The path of the optional mod
     */
    resolveMod(name){
        let pth = ''
        for (let mdl of this.server.getModules()){
            if (mdl.getName() == name){
                pth = mdl.getArtifact().getPath()
            }
        }


        return pth
    }

    /**
     * constructs the Mod argument list
     *
     */
    constructModArguments(){
        //Construct Mods
        let modArg = ""
        let i = 0
        const sep = process.platform === 'win32' ? ';' : ':'
        const id = this.server.getID()

        if (ConfigManager.getModConfiguration(this.server.getID()).mods.optional != null && ConfigManager.getModConfiguration(this.server.getID()).mods.optional !=undefined){

            for (let m of Object.values(ConfigManager.getModConfiguration(this.server.getID()).mods.optional)){

                const pth = this.resolveMod(m)
                if (i >= 1){
                    modArg += sep
                }

                modArg += pth

                i += 1
            }
            if (i > 0){
                modArg += sep
            }
        }

        modArg += path.join(this.commonDir, 'modstore', id, 'required/')

        return modArg
    }


    /**
     * Construct the argument array that will be passed to the JVM process.
     * 
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {Array.<string>} An array containing the full JVM arguments for this process.
     */
    constructJVMArguments(tempNativePath, mods){
        if(Util.mcVersionAtLeast('1.13', this.server.getMinecraftVersion())){
            return this._constructJVMArguments113(tempNativePath, mods)
        } else {
            return this._constructJVMArguments112(mods, tempNativePath)
        }
    }

    _constructJVMArguments112(mods, tempNativePath){

        const argDiscovery = /\${*(.*)}/
        let args = []

        //Construct Mods
        const modArg = this.constructModArguments()

        args.push('-Dfabric.addMods='+modArg)

        // Classpath Argument
        args.push('-cp')
        args.push(this.classpathArg(mods, tempNativePath))

        // Java Arguments
        if(process.platform === 'darwin'){
            args.push('-Xdock:name=SewerClient')
            args.push('-Xdock:icon=' + path.join(__dirname, '..', 'images', 'minecraft.icns'))
        }
        args.push('-Xmx' + ConfigManager.getMaxRAM())
        args.push('-Xms' + ConfigManager.getMinRAM())
        args = args.concat(ConfigManager.getJVMOptions())
        args.push('-Djava.library.path=' + tempNativePath)

        // Java Arguments
        if(process.platform === 'darwin'){
            args.push('-Xdock:name=SewerClient')
            args.push('-Xdock:icon=' + path.join(__dirname, '..', 'images', 'minecraft.icns'))
        }
        args.push('-Xmx' + ConfigManager.getMaxRAM())
        args.push('-Xms' + ConfigManager.getMinRAM())
        args = args.concat(ConfigManager.getJVMOptions())

        // Main Java Class
        args.push(this.forgeData.mainClass)

        args.push("--username")
        args.push(this.authUser.displayName.trim())
        args.push("--version")
        args.push(this.server.getID())


        args.push("--versionType")
        args.push("SewerClient")

        args.push("--gameDir")
        args.push(this.gameDir)

        args.push("--assetsDir")
        args.push(path.join(this.commonDir, 'assets'))

        args.push("--assetIndex")
        args.push(this.versionData.assets)

        args.push("--accessToken")
        args.push(this.authUser.accessToken)

        args.push("--uuid")
        args.push(this.authUser.uuid.trim())

        // Prepare game resolution
        if(ConfigManager.getFullscreen()){
            args.push('--fullscreen')
            args.push(true)
        } else {
            args.push('--width')
            args.push(ConfigManager.getGameWidth())
            args.push('--height')
            args.push(ConfigManager.getGameHeight())
        }

        return args
    }

    /**
     * Construct the argument array that will be passed to the JVM process.
     * 
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {Array.<string>} An array containing the full JVM arguments for this process.
     */
    _constructJVMArguments113(tempNativePath, mods){

        const argDiscovery = /\${*(.*)}/

        // JVM Arguments First
        let args = this.versionData.arguments.jvm

        //Construct Mods
        const modArg = this.constructModArguments()

        args.push('-Dfabric.addMods='+modArg)

        // Java Arguments
        if(process.platform === 'darwin'){
            args.push('-Xdock:name=SewerClient')
            args.push('-Xdock:icon=' + path.join(__dirname, '..', 'images', 'minecraft.icns'))
        }
        args.push('-Xmx' + ConfigManager.getMaxRAM())
        args.push('-Xms' + ConfigManager.getMinRAM())
        args = args.concat(ConfigManager.getJVMOptions())

        // Main Java Class
        args.push(this.forgeData.mainClass)

        // Vanilla Arguments
        args = args.concat(this.versionData.arguments.game)

        for(let i=0; i<args.length; i++){
            if(typeof args[i] === 'object' && args[i].rules != null){
                
                let checksum = 0
                for(let rule of args[i].rules){
                    if(rule.os != null){
                        if(rule.os.name === Library.mojangFriendlyOS()
                            && (rule.os.version == null || new RegExp(rule.os.version).test(os.release))){
                            if(rule.action === 'allow'){
                                checksum++
                            }
                        } else {
                            if(rule.action === 'disallow'){
                                checksum++
                            }
                        }
                    } else if(rule.features != null){
                        // We don't have many 'features' in the index at the moment.
                        // This should be fine for a while.
                        if(rule.features.has_custom_resolution != null && rule.features.has_custom_resolution === true){
                            if(ConfigManager.getFullscreen()){
                                args[i].value = [
                                    '--fullscreen',
                                    'true'
                                ]
                            }
                            checksum++
                        }
                    }
                }

                // TODO splice not push
                if(checksum === args[i].rules.length){
                    if(typeof args[i].value === 'string'){
                        args[i] = args[i].value
                    } else if(typeof args[i].value === 'object'){
                        //args = args.concat(args[i].value)
                        args.splice(i, 1, ...args[i].value)
                    }

                    // Decrement i to reprocess the resolved value
                    i--
                } else {
                    args[i] = null
                }

            } else if(typeof args[i] === 'string'){
                if(argDiscovery.test(args[i])){
                    const identifier = args[i].match(argDiscovery)[1]
                    let val = null

                    switch(identifier){
                        case 'auth_player_name':
                            val = this.authUser.displayName.trim()
                            break
                        case 'version_name':
                            //val = versionData.id
                            val = this.server.getID()
                            break
                        case 'game_directory':
                            val = this.gameDir
                            break
                        case 'assets_root':
                            val = path.join(this.commonDir, 'assets')
                            break
                        case 'assets_index_name':
                            val = this.versionData.assets
                            break
                        case 'auth_uuid':
                            val = this.authUser.uuid.trim()
                            break
                        case 'auth_access_token':
                            val = this.authUser.accessToken
                            break
                        case 'user_type':
                            val = 'mojang'
                            break
                        case 'version_type':
                            val = 'SewerClient'
                            break
                        case 'resolution_width':
                            val = ConfigManager.getGameWidth()
                            break
                        case 'resolution_height':
                            val = ConfigManager.getGameHeight()
                            break
                        case 'natives_directory':
                            val = args[i].replace(argDiscovery, tempNativePath)
                            break
                        case 'launcher_name':
                            val = args[i].replace(argDiscovery, 'SewerClient')
                            break
                        case 'launcher_version':
                            val = args[i].replace(argDiscovery, this.launcherVersion)
                            break
                        case 'classpath':
                            val = this.classpathArg(mods, tempNativePath)//.process.platform === 'win32' ? ';' : ':')
                            break
                    }
                    if(val != null){
                        args[i] = val
                    }
                }
            }
        }

        // Filter null values
        args = args.filter(arg => {
            return arg != null
        })

        return args
    }

    /**
     * Ensure that the classpath entries all point to jar files.
     * 
     * @param {Array.<String>} list Array of classpath entries.
     */
    _processClassPathList(list) {

        const ext = '.jar'
        const extLen = ext.length
        for(let i=0; i<list.length; i++) {
            const extIndex = list[i].indexOf(ext)
            if(extIndex > -1 && extIndex  !== list[i].length - extLen) {
                list[i] = list[i].substring(0, extIndex + extLen)
            }
        }

    }

    /**
     * Resolve the full classpath argument list for this process. This method will resolve all Mojang-declared
     * libraries as well as the libraries declared by the server.
     * 
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {Array.<string>} An array containing the paths of each library required by this process.
     */
    classpathArg(mods, tempNativePath){
        let cpArgs = []
        let Libs = ""
        let i = 0
        const sep = process.platform === 'win32' ? ';' : ':'

        // Add the version.jar to the classpath.
        const version = this.versionData.id
        Libs += path.join(this.commonDir, 'versions', version, version + '.jar')
        Libs += sep

        // Resolve the Mojang declared libraries.
        const mojangLibs = this._resolveMojangLibraries(tempNativePath)

        // Resolve the server declared libraries.
        const servLibs = this._resolveServerLibraries(mods)

        // Merge libraries, server libs with the same
        // maven identifier will override the mojang ones.
        // Ex. 1.7.10 forge overrides mojang's guava with newer version.
        const finalLibs = {...mojangLibs, ...servLibs}
        for (let lib of Object.values(finalLibs)){

            if (i >= 1){
                Libs += sep
            }

            Libs += lib

            i += 1
        }
        cpArgs = cpArgs.concat(Libs)

        //this._processClassPathList(cpArgs)

        return Libs
    }

    /**
     * Resolve the libraries declared by this server in order to add them to the classpath.
     * This method will also check each enabled mod for libraries, as mods are permitted to
     * declare libraries.
     *
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @returns {{[id: string]: string}} An object containing the paths of each library this server requires.
     */
    _resolveServerLibraries(mods){
        const mdls = this.server.getModules()
        let libs = {}

        // Locate Forge/Libraries
        for(let mdl of mdls){
            const type = mdl.getType()
            if(type === DistroManager.Types.Loader || type === DistroManager.Types.Library){
                libs[mdl.getVersionlessID()] = mdl.getArtifact().getPath()
                if(mdl.hasSubModules()){
                    const res = this._resolveModuleLibraries(mdl)
                    if(res.length > 0){
                        libs = {...libs, ...res}
                    }
                }
            }
        }

        //Check for any libraries in our mod list.
        for(let i=0; i<mods.length; i++){
            if(mods.sub_modules != null){
                const res = this._resolveModuleLibraries(mods[i])
                if(res.length > 0){
                    libs = {...libs, ...res}
                }
            }
        }

        return libs
    }

    /**
     * Recursively resolve the path of each library required by this module.
     *
     * @param {Object} mdl A module object from the server distro index.
     * @returns {Array.<string>} An array containing the paths of each library this module requires.
     */
    _resolveModuleLibraries(mdl){
        if(!mdl.hasSubModules()){
            return []
        }
        let libs = []
        for(let sm of mdl.getSubModules()){
            if(sm.getType() === DistroManager.Types.Library){
                libs.push(sm.getArtifact().getPath())
            }
            // If this module has submodules, we need to resolve the libraries for those.
            // To avoid unnecessary recursive calls, base case is checked here.
            if(mdl.hasSubModules()){
                const res = this._resolveModuleLibraries(sm)
                if(res.length > 0){
                    libs = libs.concat(res)
                }
            }
        }
        return libs
    }

    /**
     * Resolve the libraries defined by Mojang's version data. This method will also extract
     * native libraries and point to the correct location for its classpath.
     * 
     * TODO - clean up function
     * 
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {{[id: string]: string}} An object containing the paths of each library mojang declares.
     */
    _resolveMojangLibraries(tempNativePath){
        const libs = {}

        const libArr = this.versionData.libraries
        fs.ensureDirSync(tempNativePath)
        for(let i=0; i<libArr.length; i++){
            const lib = libArr[i]
            if(Library.validateRules(lib.rules, lib.natives)){
                if(lib.natives == null){
                    const dlInfo = lib.downloads
                    const artifact = dlInfo.artifact
                    const to = path.join(this.libPath, artifact.path)
                    const versionIndependentId = lib.name.substring(0, lib.name.lastIndexOf(':'))
                    libs[versionIndependentId] = to
                } else {
                    // Extract the native library.
                    const exclusionArr = lib.extract != null ? lib.extract.exclude : ['META-INF/']
                    const artifact = lib.downloads.classifiers[lib.natives[Library.mojangFriendlyOS()].replace('${arch}', process.arch.replace('x', ''))]
    
                    // Location of native zip.
                    const to = path.join(this.libPath, artifact.path)
    
                    let zip = new AdmZip(to)
                    let zipEntries = zip.getEntries()
    
                    // Unzip the native zip.
                    for(let i=0; i<zipEntries.length; i++){
                        const fileName = zipEntries[i].entryName
    
                        let shouldExclude = false

                        // Exclude noted files.
                        exclusionArr.forEach(function(exclusion){
                            if(fileName.indexOf(exclusion) > -1){
                                shouldExclude = true
                            }
                        })

                        // Extract the file.
                        if(!shouldExclude){
                            fs.writeFile(path.join(tempNativePath, fileName), zipEntries[i].getData(), (err) => {
                                if(err){
                                    logger.error('Error while extracting native library:', err)
                                }
                            })
                        }
    
                    }
                }
            }
        }

        return libs
    }
}


module.exports = ProcessBuilder
