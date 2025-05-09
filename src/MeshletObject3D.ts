import { Stat } from "./BetterStats"
import { Meshlet, Vertex } from "./Meshlet"

import * as THREE from "three"

import vertShader from './shader/vert.glsl'
import fragShader from './shader/frag.glsl'


interface ProcessedMeshlet {
    meshletId: number
    vertexOffset: number
    vertexCount: number
}

interface NonIndexedMeshlet {
    meshlet: Meshlet
    vertices: Float32Array
}

export class MeshletObject3D {
    private static VERTICES_TEXTURE_SIZE = 1024

    private meshlets: Meshlet[]

    private meshletsProcessed: Map<Meshlet, ProcessedMeshlet>

    private instancedGeometry: THREE.InstancedBufferGeometry
    private indicesAttribute: THREE.Uint16BufferAttribute
    private localPositionAttribute: THREE.Float32BufferAttribute

    public readonly mesh: THREE.Mesh

    private rootMeshlet: Meshlet
    private meshletMatrices: THREE.Matrix4[]

    private lodStat: Stat
    private tempMatrix: THREE.Matrix4

    constructor(meshlets: Meshlet[], stat: Stat) {
        this.meshlets = meshlets
        this.meshletMatrices = []
        this.lodStat = stat
        this.tempMatrix = new THREE.Matrix4()

        let meshletsPerLOD: Meshlet[][] = []

        for (let meshlet of this.meshlets) {
            if (!meshletsPerLOD[meshlet.lod]) {
                meshletsPerLOD[meshlet.lod] = []
            }

            meshletsPerLOD[meshlet.lod].push(meshlet)
        }

        for (let meshlets of meshletsPerLOD) {
            if (meshlets.length === 1) {
                this.rootMeshlet = meshlets[0]
                break
            }
        }

        let nonIndexedMeshlets: NonIndexedMeshlet[] = []
        for (let meshlet of this.meshlets) {
            nonIndexedMeshlets.push(this.meshletToNonIndexedVertices(meshlet))
        }

        this.meshletsProcessed = new Map()
        let currentVertexOffset = 0
        for (let nonIndexedMeshlet of nonIndexedMeshlets) {
            this.meshletsProcessed.set(
                nonIndexedMeshlet.meshlet,
                {
                    meshletId: nonIndexedMeshlet.meshlet.id,
                    vertexOffset: currentVertexOffset, 
                    vertexCount: nonIndexedMeshlet.vertices.length
                }
            )
            currentVertexOffset += nonIndexedMeshlet.vertices.length
        }

        const vertexTexture = this.createVerticesTexture(nonIndexedMeshlets)

        this.instancedGeometry = new THREE.InstancedBufferGeometry()
        this.instancedGeometry.instanceCount = 0

        const positionAttribute = new THREE.InstancedBufferAttribute(new Float32Array(1152), 3)
        this.instancedGeometry.setAttribute('position', positionAttribute)

        this.localPositionAttribute = new THREE.InstancedBufferAttribute(new Float32Array(meshlets.length * 3), 3)
        this.instancedGeometry.setAttribute('localPosition', this.localPositionAttribute)
        this.localPositionAttribute.usage = THREE.StaticDrawUsage

        this.indicesAttribute = new THREE.InstancedBufferAttribute(new Float32Array(meshlets.length), 1)
        this.instancedGeometry.setAttribute('index', this.indicesAttribute)
        this.indicesAttribute.usage = THREE.StaticDrawUsage

        const material = new THREE.ShaderMaterial({
            vertexShader: vertShader,
            fragmentShader: fragShader,
            uniforms: {
                vertexTexture: {
                    value: vertexTexture
                },
                verticesTextureSize: {
                    value: MeshletObject3D.VERTICES_TEXTURE_SIZE
                },
            },
            wireframe: false
        })

        this.mesh = new THREE.Mesh(this.instancedGeometry, material)
        this.mesh.frustumCulled = false

        let renderer: THREE.WebGLRenderer | null = null
        let camera: THREE.Camera | null = null
        this.mesh.onBeforeRender = (renderer, scene, camera, geometry) => {
            const startTime = performance.now()

            this.render(renderer, camera)

            const elapsed = performance.now() - startTime
            this.lodStat.value = `${elapsed.toFixed(3)}ms`
        }
    }

    private projectErrorToScreen(
        center: Vertex, radius: number, screenHeight: number
    ): number {
        if (radius === Infinity) {
            return radius
        }

        const testFOV = Math.PI * 0.5
        const cotHalfFov = 1.0 / Math.tan(testFOV / 2.0)
        const d2 = Vertex.dot(center, center)
        const r = radius
        return screenHeight / 2.0 * cotHalfFov * r / Math.sqrt(d2 - r * r)
    }

    private sphereApplyMatrix4(
        center: Vertex, radius: number, matrix: THREE.Matrix4)
    {
        radius = radius * matrix.getMaxScaleOnAxis()
        return {
            center: Vertex.applyMatrix4(center, matrix.elements),
            radius: radius
        }
    }

    private isMeshletVisible(
        meshlet: Meshlet, meshletMatrixWorld: THREE.Matrix4,
        cameraMatrixWorld: THREE.Matrix4, screenHeight: number
    ): boolean {
        const completeProj = this.tempMatrix.multiplyMatrices(cameraMatrixWorld, meshletMatrixWorld)

        const projectedBounds = this.sphereApplyMatrix4(
            meshlet.center, 
            Math.max(meshlet.clusterError, 10e-10),
            completeProj
        )

        const clusterError = this.projectErrorToScreen(
            projectedBounds.center,
            projectedBounds.radius, screenHeight
        )

        if (!meshlet.parentCenter) {
            console.log(meshlet)
        }

        const parentProjectedBounds = this.sphereApplyMatrix4(
            meshlet.parentCenter, 
            Math.max(meshlet.parentError, 10e-10),
            completeProj
        )

        const parentError = this.projectErrorToScreen(
            parentProjectedBounds.center,
            parentProjectedBounds.radius,
            screenHeight
        )

        const errorThreshold = 0.1
        const visible =
            clusterError <= errorThreshold
            &&
            parentError > errorThreshold

        return visible
    }

    private traverseMeshlets(
        meshlet: Meshlet,
        fn: (meshlet: Meshlet) => boolean,
        visited: { [key: string]: boolean } = {}
    ) {
        if (visited[meshlet.id] === true) {
            return
        }

        visited[meshlet.id] = true
        const shouldContinue = fn(meshlet)
        if (!shouldContinue) {
            return
        }

        for (let child of meshlet.parents) {
            this.traverseMeshlets(child, fn, visited)
        }
    }

    private meshletToNonIndexedVertices(meshlet: Meshlet): NonIndexedMeshlet {
        const g = new THREE.BufferGeometry()
        g.setAttribute("position", new THREE.Float32BufferAttribute(meshlet.vertices_raw, 3))
        g.setIndex(new THREE.Uint32BufferAttribute(meshlet.indices_raw, 1))
        const nonIndexed = g.toNonIndexed()
        const v = new Float32Array(1152)
        v.set(nonIndexed.getAttribute("position").array, 0)

        return {
            meshlet: meshlet,
            vertices: v
        }
    }

    private createVerticesTexture(meshlets: NonIndexedMeshlet[]):
        THREE.DataTexture
    {
        let vertices: number[] = []

        for (let meshlet of meshlets) {
            const v = new Float32Array(1152)
            v.set(meshlet.vertices, 0)
            vertices.push(...v)
        }
        let verticesPacked: number[][] = []
        for (let i = 0; i < vertices.length; i += 3) {
            verticesPacked.push(
                [vertices[i + 0], vertices[i + 1], vertices[i + 2], 0]
            )
        }

        const size = MeshletObject3D.VERTICES_TEXTURE_SIZE
        const buffer = new Float32Array(size * size * 4)

        buffer.set(verticesPacked.flat(), 0)
        const texture = new THREE.DataTexture(
            buffer,
            size, size,
            THREE.RGBAFormat,
            THREE.FloatType
        )
        texture.needsUpdate = true
        texture.generateMipmaps = false

        return texture
    }

    private render(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
        const screenHeight = renderer.domElement.height
        camera.updateMatrixWorld()
        const cameraMatrixWorld = camera.matrixWorldInverse

        let checks = 0, i = 0, j = 0
        for (let meshletMatrix of this.meshletMatrices) {
            this.traverseMeshlets(
                this.rootMeshlet,
                meshlet => {
                    const isVisible = this.isMeshletVisible(
                        meshlet, meshletMatrix,
                        cameraMatrixWorld, screenHeight
                    )
                    if (isVisible) {
                        const processedMeshlet = this.meshletsProcessed.get(meshlet)
                        if (!processedMeshlet) {
                            throw Error("WHHATTT")
                        }

                        this.indicesAttribute.array[i] = processedMeshlet.vertexOffset / 3

                        this.localPositionAttribute.array[j + 0] = meshletMatrix.elements[12]
                        this.localPositionAttribute.array[j + 1] = meshletMatrix.elements[13]
                        this.localPositionAttribute.array[j + 2] = meshletMatrix.elements[14]

                        j += 3
                        i++
                    }

                    checks++
                    return !isVisible
                }
            )
        }
        this.indicesAttribute.needsUpdate = true
        this.localPositionAttribute.needsUpdate = true
        this.instancedGeometry.instanceCount = i
    }

    public addMeshletAtPosition(position: THREE.Vector3) {
        const tempMesh = new THREE.Object3D()

        tempMesh.position.copy(position)
        tempMesh.updateMatrixWorld()
        this.meshletMatrices.push(tempMesh.matrixWorld.clone())

        this.localPositionAttribute = new THREE.InstancedBufferAttribute(
            new Float32Array(this.meshlets.length * this.meshletMatrices.length * 3), 3
        )
        this.instancedGeometry.setAttribute('localPosition', this.localPositionAttribute)
        this.localPositionAttribute.usage = THREE.StaticDrawUsage

        this.indicesAttribute = new THREE.InstancedBufferAttribute(
            new Float32Array(this.meshlets.length * this.meshletMatrices.length), 1
        )
        this.instancedGeometry.setAttribute('index', this.indicesAttribute)
        this.indicesAttribute.usage = THREE.StaticDrawUsage
    }
}
