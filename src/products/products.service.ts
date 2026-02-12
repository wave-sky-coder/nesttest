import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Product } from './product.entity';
import { Category } from './category.entity';
import { CreateProductDto, CreateCategoryDto } from './dto/create-product.dto';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private productsRepository: Repository<Product>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @Inject(CACHE_MANAGER)
    private cacheManager: Cache,
  ) { }

  async findAll(): Promise<Product[]> {
    return this.productsRepository.find({ relations: ['category'] });
  }

  async findOne(id: number): Promise<Product> {
    const product = await this.productsRepository.findOne({
      where: { id },
      relations: ['category'],
    });
    if (!product) {
      throw new NotFoundException(`Product #${id} not found`);
    }
    return product;
  }

  async create(createProductDto: CreateProductDto): Promise<Product> {
    const product = this.productsRepository.create(createProductDto);
    return this.productsRepository.save(product);
  }

  async updateStock(id: number, quantity: number): Promise<Product> {
    const product = await this.findOne(id);
    product.stock = quantity;
    return this.productsRepository.save(product);
  }

  async remove(id: number): Promise<void> {
    const product = await this.findOne(id);
    await this.productsRepository.remove(product);
  }

  async searchProducts(query: string): Promise<Product[]> {
    const cacheKey = `search:${query.toLowerCase().trim()}`;

    // 1. Try cache first
    const cached = await this.cacheManager.get<Product[]>(cacheKey);
    if (cached) return cached;

    // 2. Database search (SQL LIKE)
    const results = await this.productsRepository.find({
      where: [
        { name: ILike(`%${query}%`), isAvailable: true },
        { description: ILike(`%${query}%`), isAvailable: true }
      ],
      relations: ['category'],
      take: 20 // Limit results for speed
    });

    // 3. Save and return
    await this.cacheManager.set(cacheKey, results, 60000);
    return results;
  }
  async findAllCategories(): Promise<Category[]> {
    return this.categoriesRepository.find({ relations: ['parent', 'children'] });
  }

  async findCategory(id: number): Promise<Category> {
    const category = await this.categoriesRepository.findOne({
      where: { id },
      relations: ['parent', 'children', 'products'],
    });
    if (!category) {
      throw new NotFoundException(`Category #${id} not found`);
    }
    return category;
  }

  async createCategory(dto: CreateCategoryDto): Promise<Category> {
    const category = this.categoriesRepository.create(dto);
    return this.categoriesRepository.save(category);
  }

  async getCategoryTree(categoryId: number): Promise<any> {
    // 1. Fetch the category with its entire subtree
    // Note: For deep trees, you'd use a Tree Repository, but for 2-3 levels this works.
    const category = await this.categoriesRepository.findOne({
      where: { id: categoryId },
      relations: ['children'],
    });

    if (!category) throw new NotFoundException(`Category #${categoryId} not found`);

    return this.buildChildTree(category);
  }

  private buildChildTree(category: Category): any {
    return {
      id: category.id,
      name: category.name,
      // Only recurse downwards into children
      children: category.children?.map(child => this.buildChildTree(child)) || [],
    };
  }

  async processProductBatch(productIds: number[]): Promise<{ success: boolean; processed: number }> {
    let processed = 0;

    try {
      for (const id of productIds) {
        try {
          const product = await this.findOne(id);
          product.updatedAt = new Date();
          await this.productsRepository.save(product);
          processed++;
        } catch (error) {
          console.log('Error processing product');
        }
      }
    } catch (error) {
      throw new BadRequestException('Batch processing failed');
    }

    return { success: true, processed };
  }
}
